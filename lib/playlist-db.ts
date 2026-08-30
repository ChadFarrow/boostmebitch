import { Pool } from 'pg';
import { dbRowToEpisode, type DbTrackRow } from './playlist-db-map';
import { fnvHash } from './util';
import { episodeKey } from './pi-batch';
import type { Episode, ValueBlock } from './types';
import type { PlaylistItemRef } from './feed-xml';

/**
 * A read-only accelerator in front of Podcast Index for playlist tracks.
 *
 * SERVER-ONLY. It opens a Postgres socket and reads `PLAYLIST_DB_URL`; nothing
 * under `components/` may import it, and it is reached from `/api/playlist`
 * alone.
 *
 * A `musicL` playlist publishes no `<item>`s, so every track is resolved one
 * Podcast Index lookup at a time — 100 per page, thirteen pages for the
 * Homegrown Hits list. The StableKraft database already holds 13,783 of those
 * tracks with their value blocks, so a page that hits it costs one query
 * instead of a batch call, and PI is left for the misses.
 *
 * **It is an ACCELERATOR, never an authority — the same contract the Nostr read
 * index carries, and for the same reason.** Three properties make that true and
 * none of them is visible from the calling code:
 *
 * 1. **The playlist FEED still decides what is in the list and in what order.**
 *    This module is asked about `(feedGuid, itemGuid)` pairs that were parsed
 *    from the curator's own document; it never enumerates a playlist. So there
 *    is no mapping from a feed URL to a database id to keep in sync, nothing to
 *    redeploy when a playlist is added, and the "one URL, not a list of
 *    playlists" design that `/playlists` rests on is untouched.
 * 2. **A miss is not an answer.** Rows this database does not hold are returned
 *    to the caller as absent, and `/api/playlist` resolves them through PI
 *    exactly as before. That is what makes the data being months out of date
 *    harmless: a track added last week is simply not here.
 *
 *    **That argument covers MEMBERSHIP and stops there.** A stale HIT on a
 *    value block is an answer, and `payableValue` reads it before it looks
 *    anywhere else — so the blocks are handed back separately and applied only
 *    where nothing fresher could answer. Measured on one 8-row page of It's A
 *    Mood: 8 of 8 snapshots disagreed with the live feed, two of them naming a
 *    different destination node outright. See `PlaylistDbTracks.values`.
 * 3. **Every failure is `null`, never an empty result.** An unset env var, an
 *    unreachable host, a schema that moved underneath us — all of it reverts to
 *    the pre-existing path. Unset `PLAYLIST_DB_URL` and this file does nothing.
 *
 * **It is another application's database — the same owner, a different schema.**
 * We hold no migrations here and must never write to it, and StableKraft's
 * schema moves without this repo being touched, which is what makes every field
 * untrusted regardless of who owns the server. The queries name only columns observed on 2026-08-29, and
 * `lib/playlist-db-map.ts` treats every field as untrusted — see its header for
 * what the data actually contains, which is not what its field names promise.
 */

/**
 * One pool per process, created lazily.
 *
 * `max: 2` because a serverless instance handles one request at a time and the
 * upstream is a small shared Postgres — a default pool of ten per warm instance
 * is how a cache turns into an outage for the app that owns the database. The
 * idle timeout lets a cold instance let go rather than hold a connection open
 * for the life of the container.
 */
let pool: Pool | null = null;
let poolFailed = false;

function getPool(): Pool | null {
  if (poolFailed) return null;
  if (pool) return pool;
  const connectionString = process.env.PLAYLIST_DB_URL;
  if (!connectionString) return null;
  // Accepts a real multi-line PEM (Vercel) or one with escaped newlines, which
  // is the only way a certificate fits on one line of `.env.local`.
  const ca = process.env.PLAYLIST_DB_CA?.replace(/\\n/g, '\n').trim();
  if (!ca) {
    // FAIL CLOSED, and say so. Without the CA there is no way to tell this
    // database from anything that answers on its address, and the whole module
    // is an optimisation — so it turns itself off and every track resolves
    // through Podcast Index exactly as it did before the accelerator existed.
    // Warned rather than silent because the symptom otherwise is only that a
    // playlist page got slower, which nobody reports.
    poolFailed = true;
    console.warn('[playlist-db] PLAYLIST_DB_CA is not set — accelerator disabled, using Podcast Index');
    return null;
  }
  try {
    pool = new Pool({
      connectionString,
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 3_000,
      // BOTH halves of the timeout, because they fail differently. `query_timeout`
      // is ours and gives up on a socket that has gone quiet; `statement_timeout`
      // is the server's and stops a query we abandoned from going on burning
      // someone else's database. Without a ceiling this accelerator becomes
      // slower than the Podcast Index call it replaces, on the request where
      // that matters most — a cold page a reader is waiting for.
      query_timeout: 2_500,
      statement_timeout: 2_500,
      // **Pinned to the database's own root CA, because the alternative is no
      // verification at all.** Measured on 2026-08-29: the server presents a
      // self-signed leaf (`CN=localhost`, SAN `DNS:localhost`) issued by a
      // self-signed `CN=root-ca`, reached over Railway's public TCP proxy. So
      // the traffic crosses the open internet, the default check cannot pass,
      // and `rejectUnauthorized: false` — how this shipped — accepts ANY
      // certificate instead.
      //
      // That is an INTEGRITY problem, not the confidentiality one the previous
      // comment here argued. `dbValueBlock` validates the SHAPE of a value
      // block and never a payee, so an active MITM could return well-formed
      // rows naming their own node, and nothing downstream would notice. The
      // value block no longer outranks Podcast Index (see
      // `resolvePlaylistTracks`), which bounds that; the pin is what closes it.
      //
      // `checkServerIdentity` is overridden because the leaf's CN is
      // `localhost` and the hostname is the Railway proxy — the names cannot
      // match, so the CA pin is doing the whole job. That is sound here and
      // only here: the CA signs exactly one server.
      ssl: { ca, checkServerIdentity: () => undefined },
    });
    // A pool emits 'error' for an idle client dropped by the server. Without a
    // listener that is an unhandled 'error' event, which takes the process
    // down — the whole route, not just this query.
    pool.on('error', () => {});
    return pool;
  } catch {
    poolFailed = true;
    return null;
  }
}

export interface PlaylistDbTracks {
  /**
   * The rows this database answered, keyed by `episodeKey`. **Their `value` is
   * deliberately absent** — see `values`.
   */
  tracks: Map<string, Episode>;
  /**
   * Each answered track's value block, held APART from its episode.
   *
   * `payableValue` returns `episode.value` before it looks anywhere else, so a
   * block left on the episode outranks whatever Podcast Index or the artist's
   * own RSS says moments later — and this database is a crawl, months behind.
   * An artist who changed a node pubkey or moved off a Lightning-address host
   * since then would be paid at the old destination on the strength of a row
   * we happened to hold, with every leg reporting ✓.
   *
   * So the caller applies these only to rows nothing fresher could value. The
   * accelerator can still make a track payable that PI cannot resolve at all —
   * which is strictly better than the page had before it — but it can never
   * overrule a live answer. Membership and metadata are accelerated; money is
   * not.
   */
  values: Map<string, ValueBlock>;
}

/**
 * Resolve as many of `refs` as this database holds, keyed by `feedGuid:itemGuid`.
 *
 * Returns null when the database could not be asked at all — which the caller
 * must treat as "resolve everything through Podcast Index", never as "none of
 * these exist".
 *
 * **Matched on BOTH guids, never on the item guid alone.** Measured on the
 * It's A Mood playlist: 342 refs, 319 match on the pair and 332 match on the
 * item guid by itself. Those 13 extra rows are ones where this database's
 * `Feed.guid` disagrees with the feed guid the curator wrote — and the feed
 * guid is what `payableValue` compares to decide whether a track's value block
 * belongs to it or to the container. Taking the looser match would buy 4% more
 * rows by guessing at exactly the question that decides who gets paid.
 */
export async function resolvePlaylistTracks(
  refs: PlaylistItemRef[],
  feedId: number,
): Promise<PlaylistDbTracks | null> {
  if (!refs.length) return { tracks: new Map(), values: new Map() };
  const p = getPool();
  if (!p) return null;

  const itemGuids = refs.map((r) => r.itemGuid);
  // Keyed with `episodeKey`, the same function `/api/playlist` uses to look
  // rows up in this map. Hand-writing the same template in both places is how
  // a cache silently answers nothing: every lookup misses, PI resolves the
  // whole page, and the only symptom is that it got no faster.
  const wanted = new Map(refs.map((r) => [episodeKey(r), r]));

  let rows: Array<Record<string, unknown>>;
  try {
    const res = await p.query(
      // Selected by item guid and filtered to the exact pair below, rather than
      // building a 100-row VALUES join: one indexed `= any()` is what makes
      // this 117 ms for a full page.
      `select t.guid            as "itemGuid",
              f.guid            as "feedGuid",
              t.title           as "title",
              t."audioUrl"      as "audioUrl",
              t.duration        as "duration",
              coalesce(t.image, f.image) as "image",
              t."publishedAt"   as "publishedAt",
              t."v4vValue"      as "value",
              t."chaptersUrl"   as "chaptersUrl",
              -- Selected only so dbRowToEpisode can REFUSE a row we would
              -- otherwise answer with less than Podcast Index would. Never mapped.
              t."valueTimeSplits"     as "valueTimeSplits",
              t."alternateEnclosures" as "alternateEnclosures"
         from "Track" t
         join "Feed"  f on f.id = t."feedId"
        where t.guid = any($1::text[])`,
      [itemGuids],
    );
    rows = res.rows;
  } catch {
    // Unreachable, timed out, or a column that moved. Either way we have no
    // answer, and no answer is not an empty one.
    return null;
  }

  const tracks = new Map<string, Episode>();
  const values = new Map<string, ValueBlock>();
  for (const row of rows) {
    const key = episodeKey({
      feedGuid: String(row.feedGuid ?? ''),
      itemGuid: String(row.itemGuid ?? ''),
    });
    const ref = wanted.get(key);
    if (!ref) continue;      // pair disagreed — leave it for Podcast Index
    if (tracks.has(key)) continue;
    const ep = dbRowToEpisode(row as unknown as DbTrackRow, {
      // The SHARED `fnvHash`, so this row and the route's `placeholder` for the
      // same ref are one track rather than two. Imported directly: only
      // `playlist-db-map.ts` carries the type-only-imports constraint, because
      // only that module is loaded under type-stripping by a check script.
      id: -fnvHash(key),
      feedId,
      // The heading comes from the CURATOR's `<podcast:txt>` marker, never from
      // this database's own `episodeTitle`. The two normally agree, and when
      // they do not the playlist document is the one the reader is looking at.
      playlistGroup: ref.episode,
    });
    if (!ep) continue;
    // Lifted off the episode rather than never mapped, so `dbRowToEpisode`
    // stays a faithful reading of the row and this module owns the precedence
    // policy. See `PlaylistDbTracks.values`.
    const { value, ...track } = ep;
    tracks.set(key, track);
    if (value) values.set(key, value);
  }
  return { tracks, values };
}
