import { Pool } from 'pg';
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
    connectionTimeoutMillis: 3_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
    ...(ca ? { ssl: { ca, checkServerIdentity: () => undefined } } : {}),
  });
  pool.on('error', (e) => console.error('[community-store] idle client error:', e.message));
  return pool;
}

function db(): Pool {
  const p = getPool();
  if (!p) throw new Error('community store is not configured');
  return p;
}

export function communityStoreConfigured(): boolean {
  return !!process.env.COMMUNITY_DB_URL;
}

interface Row {
  id: string;
  owner_pubkey: string;
  title: string;
  description: string;
  art_url: string | null;
  songs: unknown;
  podcast_guid: string;
  created_at: Date;
  updated_at: Date;
}

const COLS = 'id, owner_pubkey, title, description, art_url, songs, podcast_guid, created_at, updated_at';

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
       (id, owner_pubkey, title, description, art_url, songs, podcast_guid, created_at, updated_at)
     select $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::jsonb, $7::text,
            date_trunc('milliseconds', now()), date_trunc('milliseconds', now())
      where not exists (select 1 from community_bans where pubkey = $2::text)
     returning ${COLS}`,
    [id, owner, d.title, d.description, d.artUrl, JSON.stringify(d.songs), guid],
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
            updated_at = greatest(date_trunc('milliseconds', now()), updated_at + interval '1 millisecond')
      where id = $1 and deleted_at is null and updated_at = $6
        and not exists (select 1 from community_bans b where b.pubkey = community_playlists.owner_pubkey)
      returning ${COLS}`,
    [id, d.title, d.description, d.artUrl, JSON.stringify(d.songs), expected],
  );
  if (rows[0]) return toStored(rows[0]);
  const cur = await getPlaylist(id);
  if (cur === 'gone' || cur === null) return 'gone';
  return (await isBanned(cur.ownerPubkey)) ? 'banned' : 'stale';
}

export async function getPlaylist(id: string): Promise<StoredRow | 'gone' | null> {
  const { rows } = await db().query<Row & { deleted_at: Date | null }>(
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
  const { rows } = await db().query<Row>(
    `select ${COLS} from community_playlists where ${where} order by created_at desc, id limit $1`,
    args,
  );
  return rows.map(toStored);
}

export async function findPlaylistByGuid(podcastGuid: string): Promise<StoredRow | null> {
  const { rows } = await db().query<Row>(
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

export async function deletePlaylistsByOwner(owner: string, by: string): Promise<number> {
  const { rowCount } = await db().query(
    `update community_playlists set deleted_at = now(), deleted_by = $2
      where owner_pubkey = $1 and deleted_at is null`,
    [owner, by],
  );
  return rowCount ?? 0;
}

export async function isBanned(pubkey: string): Promise<boolean> {
  const { rowCount } = await db().query('select 1 from community_bans where pubkey = $1', [pubkey]);
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
  const { rows } = await db().query<{ pubkey: string; banned_at: Date; banned_by: string }>(
    'select pubkey, banned_at, banned_by from community_bans order by banned_at desc',
  );
  return rows.map((r) => ({ pubkey: r.pubkey, bannedAt: r.banned_at.toISOString(), bannedBy: r.banned_by }));
}
