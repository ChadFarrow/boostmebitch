import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { communityFeedGuid } from './feed-doc';
import { communityFeedUrl } from '../curated-playlists';
import type { PlaylistDraft, PlaylistSong, StoredPlaylist } from './rules';

// SERVER-ONLY. Opens a Postgres socket and reads COMMUNITY_DB_URL. Unlike
// lib/playlist-db.ts this database is ours and is written to: the schema is
// scripts/community-schema.sql (`npm run community:schema`).

let pool: Pool | null = null;

function getPool(): Pool | null {
  if (pool) return pool;
  const connectionString = process.env.COMMUNITY_DB_URL;
  if (!connectionString) return null;
  // Same CA handling as lib/playlist-db.ts: a real PEM (Vercel) or one with
  // escaped newlines. With no CA the connection string decides (a local,
  // non-TLS database, or `sslmode=` in the URL).
  const ca = process.env.COMMUNITY_DB_CA?.replace(/\\n/g, '\n').trim();
  pool = new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    // 5 s, not 3: a NEW serverless instance opens a new TLS connection, and on
    // 2026-11-15 the first request to a fresh beta deployment failed with
    // "Connection terminated due to connection timeout" at exactly 3 s, while
    // the RETRY a few seconds later answered at once. `readQuery` adds one more
    // try for reads, so a read waits at most two of these.
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
    ...(ca ? { ssl: { ca, checkServerIdentity: () => undefined } } : {}),
  });
  pool.on('error', (e) => console.error('[community-store] idle client error:', e.message));
  return pool;
}

/**
 * The same pool, for the one other table in this database: `live_feeds`, the
 * known-live list (lib/live-feeds.ts). `null` when the store is not configured.
 * One pool per instance, because `max: 3` is a budget against the database's
 * own connection cap, and a second pool would double it.
 */
export function communityPool(): Pool | null {
  return getPool();
}

function db(): Pool {
  const p = getPool();
  if (!p) throw new Error('community store is not configured');
  return p;
}

/** A failure to CONNECT (or a socket dropped under us): the query never ran. */
const CONNECT_FAILED = /connection timeout|Connection terminated unexpectedly|ECONNRESET|ECONNREFUSED|ETIMEDOUT/i;

/**
 * A READ, tried once more when the connection failed. Safe only because a read
 * changes nothing; a write never retries here, so a write that may have reached
 * the database is never sent twice. The playlist feeds that podcast apps fetch,
 * the /playlists list and the guid lookup all read through this, and each of
 * them otherwise failed on the first request to a new instance.
 */
async function readQuery<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
  try {
    return await db().query<R>(text, values);
  } catch (e) {
    if (!(e instanceof Error) || !CONNECT_FAILED.test(e.message)) throw e;
    console.warn('[community-store] read could not connect, trying once more:', e.message);
    return db().query<R>(text, values);
  }
}

export function communityStoreConfigured(): boolean {
  return !!process.env.COMMUNITY_DB_URL;
}

interface Row {
  id: string;
  owner_pubkey: string;
  owner_name: string | null;
  title: string;
  description: string;
  art_url: string | null;
  songs: unknown;
  podcast_guid: string;
  created_at: Date;
  updated_at: Date;
}

const COLS = 'id, owner_pubkey, owner_name, title, description, art_url, songs, podcast_guid, created_at, updated_at';

// `timestamptz` has microsecond precision and a JS Date has milliseconds, so a
// round trip through Date would break the `updated_at = $n` compare. The
// timestamps are therefore selected as text-safe ISO strings by the app writing
// them with millisecond precision only (see `now()` below): every value this
// module stores is already a whole millisecond.
/** A stored playlist with the feed guid saved when it was created. */
export type StoredRow = StoredPlaylist & { podcastGuid: string };

function toStored(r: Row): StoredRow {
  const songs = (Array.isArray(r.songs) ? r.songs : []) as PlaylistSong[];
  return {
    id: r.id,
    ownerPubkey: r.owner_pubkey,
    ownerName: r.owner_name ?? '',
    title: r.title,
    description: r.description,
    artUrl: r.art_url,
    songs,
    podcastGuid: r.podcast_guid,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** `'banned'` when the owner is banned at the moment of the write (the test is inside the INSERT). */
export async function createPlaylist(owner: string, d: PlaylistDraft): Promise<StoredRow | 'banned'> {
  const id = crypto.randomUUID();
  const guid = communityFeedGuid(communityFeedUrl(id));
  const { rows } = await db().query<Row>(
    `insert into community_playlists
       (id, owner_pubkey, title, description, art_url, songs, podcast_guid, owner_name, created_at, updated_at)
     select $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::jsonb, $7::text, $8::text,
            date_trunc('milliseconds', now()), date_trunc('milliseconds', now())
      where not exists (select 1 from community_bans where pubkey = $2::text)
     returning ${COLS}`,
    [id, owner, d.title, d.description, d.artUrl, JSON.stringify(d.songs), guid, d.ownerName || null],
  );
  return rows[0] ? toStored(rows[0]) : 'banned';
}

export async function updatePlaylist(
  id: string,
  d: PlaylistDraft,
  expectedUpdatedAt: string,
): Promise<StoredRow | 'gone' | 'stale' | 'banned'> {
  const expected = new Date(expectedUpdatedAt);
  if (Number.isNaN(expected.getTime())) return 'stale';
  // updated_at moves strictly forward, so two quick edits never share a value.
  // The ban test is part of the UPDATE: a ban that lands after a route's own
  // isBanned read still stops this write.
  const { rows } = await db().query<Row>(
    `update community_playlists
        set title = $2, description = $3, art_url = $4, songs = $5::jsonb,
            owner_name = $7::text,
            updated_at = greatest(date_trunc('milliseconds', now()), updated_at + interval '1 millisecond')
      where id = $1 and deleted_at is null and updated_at = $6
        and not exists (select 1 from community_bans b where b.pubkey = community_playlists.owner_pubkey)
      returning ${COLS}`,
    [id, d.title, d.description, d.artUrl, JSON.stringify(d.songs), expected, d.ownerName || null],
  );
  if (rows[0]) return toStored(rows[0]);
  const cur = await getPlaylist(id);
  if (cur === 'gone' || cur === null) return 'gone';
  return (await isBanned(cur.ownerPubkey)) ? 'banned' : 'stale';
}

export async function getPlaylist(id: string): Promise<StoredRow | 'gone' | null> {
  const { rows } = await readQuery<Row & { deleted_at: Date | null }>(
    `select ${COLS}, deleted_at from community_playlists where id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return r.deleted_at ? 'gone' : toStored(r);
}

export async function listPlaylists(o: { limit: number; owner?: string }): Promise<StoredRow[]> {
  const limit = Math.max(1, Math.min(200, Math.floor(o.limit)));
  const args: unknown[] = [limit];
  let where = 'deleted_at is null';
  if (o.owner) {
    args.push(o.owner);
    where += ' and owner_pubkey = $2';
  }
  const { rows } = await readQuery<Row>(
    `select ${COLS} from community_playlists where ${where} order by created_at desc, id limit $1`,
    args,
  );
  return rows.map(toStored);
}

export async function findPlaylistByGuid(podcastGuid: string): Promise<StoredRow | null> {
  const { rows } = await readQuery<Row>(
    `select ${COLS} from community_playlists where podcast_guid = $1 and deleted_at is null`,
    [podcastGuid],
  );
  return rows[0] ? toStored(rows[0]) : null;
}

export async function deletePlaylist(id: string, by: 'owner' | string): Promise<boolean> {
  const { rowCount } = await db().query(
    `update community_playlists set deleted_at = now(), deleted_by = $2
      where id = $1 and deleted_at is null`,
    [id, by],
  );
  return (rowCount ?? 0) > 0;
}

/** Deletes every live playlist of one owner; returns their ids (for the Podcast Index ping). */
export async function deletePlaylistsByOwner(owner: string, by: string): Promise<string[]> {
  const { rows } = await db().query<{ id: string }>(
    `update community_playlists set deleted_at = now(), deleted_by = $2
      where owner_pubkey = $1 and deleted_at is null
      returning id`,
    [owner, by],
  );
  return rows.map((r) => r.id);
}

export async function isBanned(pubkey: string): Promise<boolean> {
  const { rowCount } = await readQuery('select 1 from community_bans where pubkey = $1', [pubkey]);
  return (rowCount ?? 0) > 0;
}

export async function banPubkey(pubkey: string, by: string): Promise<void> {
  await db().query(
    `insert into community_bans (pubkey, banned_by) values ($1, $2) on conflict (pubkey) do nothing`,
    [pubkey, by],
  );
}

export async function unbanPubkey(pubkey: string): Promise<void> {
  await db().query('delete from community_bans where pubkey = $1', [pubkey]);
}

export async function listBans(): Promise<{ pubkey: string; bannedAt: string; bannedBy: string }[]> {
  const { rows } = await readQuery<{ pubkey: string; banned_at: Date; banned_by: string }>(
    'select pubkey, banned_at, banned_by from community_bans order by banned_at desc',
  );
  return rows.map((r) => ({ pubkey: r.pubkey, bannedAt: r.banned_at.toISOString(), bannedBy: r.banned_by }));
}

// ── Podcast Index notice state (lib/community/pi-notify.ts) ──────────────────
// Three columns that only these functions read (scripts/community-schema.sql). They
// are NOT in COLS on purpose: the public feeds and lists never select them, so a
// deploy that reaches a database without them keeps every feed working, and only the
// notices stop (fail closed) until `npm run community:schema` runs.

// `maker_ln`: the maker's Lightning address, the playlist ZAP tile's HINT (rules.ts,
// `cleanMakerLn`). NOT in COLS either, for the same reason as the pi_* columns: a
// deploy that reaches a database without it keeps every feed, list and SAVE working,
// and only the hint is missing until `npm run community:schema` runs.

/** Store (a string) or clear (null) the maker's Lightning address. False: no column. */
export async function setMakerLn(id: string, makerLn: string | null): Promise<boolean> {
  try {
    await db().query(
      'update community_playlists set maker_ln = $2 where id = $1 and maker_ln is distinct from $2',
      [id, makerLn],
    );
    return true;
  } catch (e) {
    if (isMissingColumn(e)) {
      console.warn('[community] no maker_ln column: run `npm run community:schema`; the ZAP hint is not stored');
      return false;
    }
    throw e;
  }
}

/**
 * Who owns the live playlist with this guid, and whether a Lightning address is stored
 * for them. `null`: no such live playlist. `zappable: null`: no column (unknown).
 */
export async function readMakerHint(
  podcastGuid: string,
): Promise<{ owner: string; zappable: boolean | null } | null> {
  try {
    const r = await readQuery<{ owner_pubkey: string; maker_ln: string | null }>(
      'select owner_pubkey, maker_ln from community_playlists where podcast_guid = $1 and deleted_at is null',
      [podcastGuid],
    );
    const row = r.rows[0];
    return row ? { owner: row.owner_pubkey, zappable: !!row.maker_ln } : null;
  } catch (e) {
    if (!isMissingColumn(e)) throw e;
    const found = await findPlaylistByGuid(podcastGuid);
    return found ? { owner: found.ownerPubkey, zappable: null } : null;
  }
}

/** Postgres "undefined_column": the schema with the pi_* columns was not applied. */
export function isMissingColumn(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: unknown }).code === '42703';
}

/** What the notice rules read for one live playlist (`piNoticeAllowed` in rules.ts). */
export interface PiNoticeRow {
  podcastGuid: string;
  songCount: number;
  banned: boolean;
  piFeedId: number | null;
  /** Read back as written (whole milliseconds), so `claimPiNotice` can compare it. */
  piNotifiedAt: Date | null;
  piFirstNotifiedAt: Date | null;
  ownerFirstToday: number;
  allFirstToday: number;
}

/**
 * The notice state of one LIVE playlist, or null when it is gone or unknown. The two
 * counts are first notices since `now - dayMs`, deleted playlists included: a feed
 * that was announced was announced.
 */
export async function readPiNoticeRow(id: string, now: Date, dayMs: number): Promise<PiNoticeRow | null> {
  const { rows } = await readQuery<{
    podcast_guid: string; song_count: number; banned: boolean; pi_feed_id: string | null;
    pi_notified_at: Date | null; pi_first_notified_at: Date | null; owner_first_today: number; all_first_today: number;
  }>(
    `select p.podcast_guid,
            jsonb_array_length(p.songs) as song_count,
            exists (select 1 from community_bans b where b.pubkey = p.owner_pubkey) as banned,
            p.pi_feed_id, p.pi_notified_at, p.pi_first_notified_at,
            (select count(*) from community_playlists o
              where o.owner_pubkey = p.owner_pubkey
                and o.pi_first_notified_at > $2::timestamptz - interval '1 millisecond' * $3::float8)::int as owner_first_today,
            (select count(*) from community_playlists a
              where a.pi_first_notified_at > $2::timestamptz - interval '1 millisecond' * $3::float8)::int as all_first_today
       from community_playlists p
      where p.id = $1 and p.deleted_at is null`,
    [id, now, dayMs],
  );
  const r = rows[0];
  if (!r) return null;
  // bigint comes back as a string; a PI feed id fits a double.
  const pi = r.pi_feed_id === null ? null : Number(r.pi_feed_id);
  return {
    podcastGuid: r.podcast_guid,
    songCount: r.song_count,
    banned: r.banned,
    piFeedId: pi !== null && Number.isSafeInteger(pi) && pi > 0 ? pi : null,
    piNotifiedAt: r.pi_notified_at,
    piFirstNotifiedAt: r.pi_first_notified_at,
    ownerFirstToday: r.owner_first_today,
    allFirstToday: r.all_first_today,
  };
}

/**
 * Take the notice slot of one playlist: set `pi_notified_at` to `at` (and the first
 * notice time, once), but only if it still holds `prev`, the value the rules were
 * given. Two SAVEs at once read the same `prev`; one of them updates the row and the
 * other gets false, so one notice goes, not two. A write, so it is never retried.
 */
export async function claimPiNotice(id: string, prev: Date | null, at: Date): Promise<boolean> {
  const { rowCount } = await db().query(
    `update community_playlists
        set pi_notified_at = $3::timestamptz,
            pi_first_notified_at = coalesce(pi_first_notified_at, $3::timestamptz)
      where id = $1 and deleted_at is null and pi_notified_at is not distinct from $2::timestamptz`,
    [id, prev, at],
  );
  return (rowCount ?? 0) > 0;
}

/** Store the Podcast Index feed id a lookup found. */
export async function setPiFeedId(id: string, piFeedId: number): Promise<void> {
  await db().query(
    'update community_playlists set pi_feed_id = $2 where id = $1 and pi_feed_id is distinct from $2',
    [id, piFeedId],
  );
}

/** The notice state of the live playlists, for /admin. */
export interface PiState { id: string; podcastGuid: string; piFeedId: number | null; piNotifiedAt: string | null }

export async function listPiStates(limit: number): Promise<PiState[]> {
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  const { rows } = await readQuery<{ id: string; podcast_guid: string; pi_feed_id: string | null; pi_notified_at: Date | null }>(
    `select id, podcast_guid, pi_feed_id, pi_notified_at from community_playlists
      where deleted_at is null order by created_at desc, id limit $1`,
    [n],
  );
  return rows.map((r) => {
    const pi = r.pi_feed_id === null ? null : Number(r.pi_feed_id);
    return {
      id: r.id,
      podcastGuid: r.podcast_guid,
      piFeedId: pi !== null && Number.isSafeInteger(pi) && pi > 0 ? pi : null,
      piNotifiedAt: r.pi_notified_at ? r.pi_notified_at.toISOString() : null,
    };
  });
}
