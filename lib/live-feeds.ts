// SERVER-ONLY. The known-live list: every feed seen carrying a
// `<podcast:liveItem>`, kept in the `live_feeds` table of the community
// database (scripts/community-schema.sql) and checked every 15 minutes by
// `/api/cron/live-feeds` (vercel.json).
//
// WHY IT EXISTS. Chad, 2026-11-25: "can we check for known rss live shows on a
// schedule?" `/api/live-shows` finds a schedule only in a feed something told it
// to read: Podcast Index's live list, a live podping, the visitor's favorites,
// or the per-instance memory of feeds seen live — and that memory is empty on a
// new instance. A show PI stops listing then reaches no new visitor at all.
// This list is durable, shared by every instance, and grows by itself.
//
// IT NAMES FEEDS, NEVER ROWS. The route reads every feed on it from the feed's
// own RSS, through the same path as every other source, so a payee
// (`value`, `liveValue`) and an on-air flag always come from the publisher's
// feed of this minute, never from a stored copy — and a stored `live` row would
// be the forgotten-flag bug again. What the table keeps is bookkeeping: the URL
// (so a read skips the Podcast Index stage), the station flag (so a station is
// planned into the 24/7 allowance on every instance, cold or warm), whether the
// last read found a live or pending item, and the validators for the next
// conditional read.
//
// AN ACCELERATOR, NEVER AN AUTHORITY. Unset, unreachable, slow, or the table
// not made yet: the route gives the answer it gave before this existed, never
// fewer rows. Only the 15-minute check writes.
//
// WHO JOINS. Only public sources: Podcast Index's live list, live podpings, and
// the hand list below. Never a visitor's favorites — a favorite can be private,
// and one visitor's list must not change another visitor's page. A feed from a
// public source joins only after the check's own read finds a
// `<podcast:liveItem>` in it (podping is a public chain anybody can write to).

import type { Pool } from 'pg';
import { communityPool } from './community/store';
import { checkLiveFeed, getGlobalLiveItemsDetailed, getPodcast } from './pi';
import { fetchPodpingLiveFeeds } from './podping-live';
import { createBoundedCache } from './bounded-cache';
import { httpUrl, liveFeedExpired, liveFeedVerdict, mapLimit, FEED_FANOUT, PI_FANOUT } from './util';

/** A feed on the list, as `/api/live-shows` reads it. */
export interface KnownLiveFeed {
  id: number;
  url: string;
  podcastGuid?: string;
  title?: string;
  image?: string;
  /** The last read found a live item spanning a day or more (`liveItemIsAlwaysOn`). */
  alwaysOn: boolean;
  /** The last read found a live item that is on air. */
  hasLive: boolean;
  /** The last read found a pending item that is not over. */
  hasPending: boolean;
}

/**
 * Shows on the list by hand. They join without waiting for a public source and
 * never expire (`liveFeedExpired`).
 */
export const HAND_LIVE_FEEDS: readonly { id: number; url: string }[] = [
  // Chad, 2026-11-25: "i dont see the next chad and reeds podcast for example".
  { id: 7968805, url: 'https://serve.podhome.fm/rss/7c6f7875-2b73-491e-b32c-e2c8d6e91d53' },
];

/**
 * The two tables, made by the first check run on a database that lacks them
 * (Chad, 2026-11-25: the app makes them, so nobody runs a command). The same
 * text is in scripts/community-schema.sql for a manual run. Idempotent — and
 * `create table if not exists` never changes a table that exists, so a column
 * added later needs an `alter table … add column if not exists` in BOTH copies.
 *
 * Per feed, beyond the name and the flags the page plans with:
 *  - `any_item`: the last full read found a `<podcast:liveItem>` of any status,
 *    so a `304` can renew `last_item_at` without a body.
 *  - `read_failures`: consecutive failed reads. The page skips a feed at
 *    `MAX_READ_FAILURES`, so a hung host does not cost every request a read.
 *  - `read_at`: the last `200`. Past `FULL_READ_EVERY` the check reads without
 *    validators, because the flags depend on the clock too: a pending item whose
 *    time passed is over (`liveBroadcastIsOver`) in a feed that never changed.
 *
 * `live_feeds_runs` holds one row: the time of the last run, for the claim.
 */
export const LIVE_FEEDS_SCHEMA = `
create table if not exists live_feeds (
  feed_id bigint primary key,
  url text not null,
  podcast_guid text,
  title text,
  image text,
  source text not null,
  always_on boolean not null default false,
  has_live boolean not null default false,
  has_pending boolean not null default false,
  any_item boolean not null default false,
  read_failures int not null default 0,
  etag text,
  last_modified text,
  checked_at timestamptz,
  read_at timestamptz,
  last_item_at timestamptz,
  first_seen timestamptz not null default now()
);
create table if not exists live_feeds_runs (
  id int primary key,
  last_run timestamptz not null
);
insert into live_feeds_runs (id, last_run) values (1, 'epoch') on conflict (id) do nothing;
`;

/** Any fixed number: the advisory lock that makes two first runs make the tables once. */
const SCHEMA_LOCK = 762_916_933;

/**
 * Make the tables. In one transaction behind an advisory lock, because both
 * Vercel projects fire the cron in the same minute, and two concurrent
 * `create table if not exists` of one name can fail on Postgres' catalog.
 */
async function ensureLiveFeedsSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1)', [SCHEMA_LOCK]);
    await client.query(LIVE_FEEDS_SCHEMA);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Postgres "relation does not exist": the schema has not been run yet. */
const MISSING_TABLE = '42P01';

/** A failure to CONNECT: the query never ran (the same test as lib/community/store.ts). */
const CONNECT_FAILED = /connection timeout|Connection terminated unexpectedly|ECONNRESET|ECONNREFUSED|ETIMEDOUT/i;

/**
 * How long one route request WAITS for the list before it answers without it.
 * Only the wait: the read itself goes on and fills the cache for the requests
 * after it, because a new instance's first TLS connect can take seconds
 * (lib/community/store.ts measured one fail at 3 s), and a read thrown away at
 * the deadline would make every cold instance pay that again.
 */
const READ_WAIT_MS = 2_000;

/** How long an instance reuses the list it read. The check writes every 15 min. */
const READ_CACHE_MS = 60_000;

/**
 * After a read that FAILED (an error, never the route's own wait), how long an
 * instance answers `failed` without asking, so an unhealthy database is not
 * asked by every request.
 */
const FAIL_BACKOFF_MS = 30_000;
let lastFailAt = 0;

/** The page skips a feed after this many failed reads in a row. */
const MAX_READ_FAILURES = 2;

/**
 * Ceilings on one check run, sized under the cron route's `maxDuration` (120 s):
 * at most ceil(24/6)×8 s of Podcast Index lookups plus ceil((24+48)/8)×8 s of
 * feed reads, each capped at 8 s. A run is normally ~10 s. Each row is written
 * as its read lands, so a run cut short keeps what it did.
 */
const NEW_PER_RUN = 24;
const CHECK_PER_RUN = 48;
/** The most feeds the list holds. A public chain can name any feed. */
const MAX_ROWS = 400;
/** A station has no schedule to find, so it is re-checked only this often. */
const STATION_RECHECK = '6 hours';
/** A feed is read whole, without validators, at least this often. See the schema. */
const FULL_READ_EVERY = '6 hours';
/** Two runs this close together are one run (both projects fire; a stranger may GET). */
const RUN_GAP = '10 minutes';

function pgCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

/** Resolves `timeout` at `ms`; never rejects for the deadline itself. */
function waitAtMost<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve('timeout'), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

type ListAnswer = KnownLiveFeed[] | 'no-table';

const readCache = createBoundedCache<ListAnswer>({ maxAgeMs: READ_CACHE_MS, maxEntries: 1 });

/** One read in flight per instance; every request that arrives meanwhile shares it. */
let inflight: Promise<ListAnswer> | null = null;

async function queryList(pool: Pool): Promise<ListAnswer> {
  type R = {
    feed_id: string; url: string; podcast_guid: string | null; title: string | null; image: string | null;
    always_on: boolean; has_live: boolean; has_pending: boolean;
  };
  const sql = `select feed_id, url, podcast_guid, title, image, always_on, has_live, has_pending
                 from live_feeds
                where (always_on or has_live or has_pending) and read_failures < ${MAX_READ_FAILURES}
                order by feed_id
                limit ${MAX_ROWS}`;
  let res;
  try {
    res = await pool.query<R>(sql);
  } catch (e) {
    if (pgCode(e) === MISSING_TABLE) return 'no-table';
    // Once more on a failed CONNECT, as `readQuery` does: a read changes nothing.
    if (!(e instanceof Error) || !CONNECT_FAILED.test(e.message)) throw e;
    res = await pool.query<R>(sql);
  }
  const feeds: KnownLiveFeed[] = [];
  for (const r of res.rows) {
    const id = Number(r.feed_id);
    const url = httpUrl(r.url);
    if (!Number.isInteger(id) || id <= 0 || !url) continue;
    feeds.push({
      id,
      url,
      podcastGuid: r.podcast_guid ?? undefined,
      title: r.title ?? undefined,
      image: r.image ?? undefined,
      alwaysOn: r.always_on,
      hasLive: r.has_live,
      hasPending: r.has_pending,
    });
  }
  return feeds;
}

/**
 * The feeds on the list that the route may read: stations, and feeds whose last
 * check found a live or pending item, less those that failed their last reads.
 *
 * `off` is "there is no list here" — no database configured, or the table not
 * made yet — and is cached like an answer. `failed` is "the list did not answer
 * in time": the route answers without it, exactly as before the list existed.
 */
export async function readKnownLiveFeeds(
  now = Date.now(),
): Promise<{ status: 'ok' | 'off' | 'failed'; feeds: KnownLiveFeed[] }> {
  const pool = communityPool();
  if (!pool) return { status: 'off', feeds: [] };
  const answer = (v: ListAnswer) =>
    v === 'no-table' ? { status: 'off' as const, feeds: [] } : { status: 'ok' as const, feeds: v };
  const hit = readCache.get('known', now);
  if (hit) return answer(hit.value);
  if (!inflight && now - lastFailAt < FAIL_BACKOFF_MS) return { status: 'failed', feeds: [] };
  if (!inflight) {
    inflight = queryList(pool)
      .then(
        (v) => { readCache.set('known', v, Date.now()); return v; },
        (e) => {
          lastFailAt = Date.now();
          console.warn('[live-feeds] list read failed:', e instanceof Error ? e.message : 'error');
          throw e;
        },
      )
      .finally(() => { inflight = null; });
    // The read outlives this request's wait; its failure is logged above.
    inflight.catch(() => {});
  }
  try {
    const v = await waitAtMost(inflight, READ_WAIT_MS);
    return v === 'timeout' ? { status: 'failed', feeds: [] } : answer(v);
  } catch {
    return { status: 'failed', feeds: [] };
  }
}

export interface LiveFeedsRun {
  status: 'ran' | 'too-soon' | 'off';
  /** Feeds on the list after this run, and how many the page may read. */
  known?: number;
  readable?: number;
  /** New feeds a public source named and this run read. */
  candidates?: number;
  /** Of those, how many carried a `<podcast:liveItem>`. */
  added?: number;
  checked?: number;
  notModified?: number;
  modified?: number;
  failed?: number;
  expired?: number;
}

interface Row {
  feed_id: string;
  url: string;
  source: string;
  etag: string | null;
  last_modified: string | null;
  read_at: Date | null;
  last_item_at: Date | null;
  first_seen: Date;
}

/**
 * One run of the 15-minute check. Called by `/api/cron/live-feeds` only.
 *
 *  1. CLAIM the run with one atomic UPDATE, so the two Vercel projects firing
 *     in the same minute, or a stranger's GET, make one run per `RUN_GAP`.
 *  2. Put the hand list on the list.
 *  3. Read every feed a public source names that the list does not hold yet.
 *     One carrying a `<podcast:liveItem>` joins with its flags. One from Podcast
 *     Index's roster without one joins with NO flags — the page never reads
 *     it, and the next run re-reads it with validators instead of downloading
 *     it again as a new candidate. A podping-only feed without one is not kept.
 *  4. Name the feeds that have no title yet.
 *  5. Re-read the oldest-checked feeds conditionally: a `304` costs no body. A
 *     failed read changes no flag and does not renew `last_item_at`.
 *  6. Remove feeds `liveFeedExpired` says have left.
 */
export async function runLiveFeedsCheck(now = Date.now()): Promise<LiveFeedsRun> {
  const pool = communityPool();
  if (!pool) return { status: 'off' };
  const claimRun = () => pool.query(
    `update live_feeds_runs set last_run = now()
      where id = 1 and last_run < now() - interval '${RUN_GAP}'
      returning id`,
  );
  let claim;
  try {
    claim = await claimRun();
  } catch (e) {
    if (pgCode(e) !== MISSING_TABLE) throw e;
    await ensureLiveFeedsSchema(pool);
    claim = await claimRun();
  }
  if (!claim.rowCount) return { status: 'too-soon' };

  for (const f of HAND_LIVE_FEEDS) {
    await pool.query(
      `insert into live_feeds (feed_id, url, source) values ($1, $2, 'hand')
       on conflict (feed_id) do update set source = 'hand'`,
      [f.id, f.url],
    );
  }

  const held = (await pool.query<{ feed_id: string }>(`select feed_id from live_feeds`)).rows
    .map((r) => Number(r.feed_id));

  const added = await addNewFeeds(pool, new Set(held), held.length);
  await fillMissingNames(pool);
  const checks = await recheckFeeds(pool, new Date(now));

  // Judged on the rows as the recheck left them: a feed whose read just now
  // found a live item must not be expired on a snapshot taken before it.
  const after = (await pool.query<Row>(
    `select feed_id, url, source, etag, last_modified, read_at, last_item_at, first_seen from live_feeds`,
  )).rows;
  let expired = 0;
  for (const r of after) {
    const gone = liveFeedExpired(
      {
        hand: r.source === 'hand',
        lastItemAt: r.last_item_at ? r.last_item_at.getTime() : null,
        firstSeen: r.first_seen.getTime(),
      },
      now,
    );
    if (!gone) continue;
    const del = await pool.query(`delete from live_feeds where feed_id = $1 and source <> 'hand'`, [r.feed_id]);
    expired += del.rowCount ?? 0;
  }

  const count = await pool.query<{ n: string; readable: string }>(
    `select count(*) as n,
            count(*) filter (where (always_on or has_live or has_pending) and read_failures < ${MAX_READ_FAILURES}) as readable
       from live_feeds`,
  );
  return {
    status: 'ran',
    known: Number(count.rows[0]?.n ?? 0),
    readable: Number(count.rows[0]?.readable ?? 0),
    ...added,
    ...checks,
    expired,
  };
}

/** Step 3: feeds Podcast Index's live list or a live podping names that the list lacks. */
async function addNewFeeds(
  pool: Pool,
  held: ReadonlySet<number>,
  rowCount: number,
): Promise<{ candidates: number; added: number }> {
  const [roster, podping] = await Promise.all([
    // Podcast Index unreachable costs this run its roster, nothing else.
    getGlobalLiveItemsDetailed().catch(() => null),
    fetchPodpingLiveFeeds(),
  ]);
  const onRoster = new Set((roster?.items ?? []).map((e) => Number(e.feedId)));
  const podpingUrl = new Map((podping ?? []).map((f) => [f.feedId, f.url]));
  const ids: number[] = [];
  for (const id of [...onRoster, ...podpingUrl.keys()]) {
    if (!Number.isInteger(id) || id <= 0 || held.has(id) || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= NEW_PER_RUN) break;
  }
  const take = ids.slice(0, Math.max(0, MAX_ROWS - rowCount));
  if (!take.length) return { candidates: 0, added: 0 };

  const pods = await mapLimit(take, PI_FANOUT, (id) => getPodcast(id).catch(() => null));
  const found = take
    .map((id, i) => ({
      id,
      url: httpUrl(pods[i]?.url) ?? httpUrl(podpingUrl.get(id)),
      podcastGuid: pods[i]?.podcastGuid,
      title: pods[i]?.title,
      image: pods[i]?.image ?? pods[i]?.artwork,
      source: onRoster.has(id) ? 'pi' : 'podping',
    }))
    .filter((f): f is typeof f & { url: string } => !!f.url);
  let added = 0;
  await mapLimit(found, FEED_FANOUT, async (f) => {
    const r = await checkLiveFeed(f.url, {});
    if (r.kind !== 'read') return;
    if (!r.anyLiveItem && f.source !== 'pi') return;
    const v = r.anyLiveItem ? liveFeedVerdict(r.items) : { alwaysOn: false, hasLive: false, hasPending: false };
    const ins = await pool.query(
      `insert into live_feeds
         (feed_id, url, podcast_guid, title, image, source, always_on, has_live, has_pending, any_item,
          etag, last_modified, checked_at, read_at, last_item_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now(),
               case when $10 then now() else null end)
       on conflict (feed_id) do nothing`,
      [f.id, f.url, f.podcastGuid ?? null, f.title ?? null, f.image ?? null, f.source,
        v.alwaysOn, v.hasLive, v.hasPending, r.anyLiveItem, r.etag ?? null, r.lastModified ?? null],
    );
    if (r.anyLiveItem) added += ins.rowCount ?? 0;
  });
  return { candidates: take.length, added };
}

/**
 * Step 4: a feed on the list with no title yet (a hand-listed one, or one only a
 * podping named) gets Podcast Index's name, art and guid. The route skips the
 * Podcast Index stage for a listed feed, so without this its row would show no
 * show name. A few per run; a feed Podcast Index does not know stays nameless
 * and the row falls back to the live item's own title.
 */
async function fillMissingNames(pool: Pool): Promise<void> {
  const nameless = (await pool.query<{ feed_id: string }>(
    `select feed_id from live_feeds where title is null order by feed_id limit 10`,
  )).rows.map((r) => Number(r.feed_id));
  const pods = await mapLimit(nameless, PI_FANOUT, (id) => getPodcast(id).catch(() => null));
  for (let i = 0; i < nameless.length; i++) {
    const p = pods[i];
    if (!p?.title) continue;
    await pool.query(
      `update live_feeds set title = $2, image = coalesce($3, image), podcast_guid = coalesce($4, podcast_guid)
        where feed_id = $1`,
      [nameless[i], p.title, p.image ?? p.artwork ?? null, p.podcastGuid ?? null],
    );
  }
}

/** Step 5: the oldest-checked feeds, read with the validators the last read kept. */
async function recheckFeeds(
  pool: Pool,
  runStart: Date,
): Promise<{ checked: number; notModified: number; modified: number; failed: number }> {
  // `checked_at < runStart`: a feed added a moment ago in step 3 was just read.
  // `stale`: no full read for FULL_READ_EVERY, so this one goes without validators.
  const due = (await pool.query<Row & { stale: boolean }>(
    `select feed_id, url, source, etag, last_modified, read_at, last_item_at, first_seen,
            (read_at is null or read_at < now() - interval '${FULL_READ_EVERY}') as stale
       from live_feeds
      where (checked_at is null or checked_at < $1)
        and (not always_on or checked_at is null or checked_at < now() - interval '${STATION_RECHECK}')
      order by checked_at asc nulls first
      limit ${CHECK_PER_RUN}`,
    [runStart],
  )).rows;
  let notModified = 0;
  let modified = 0;
  let failed = 0;
  await mapLimit(due, FEED_FANOUT, async (row) => {
    const url = httpUrl(row.url);
    const r = url
      ? await checkLiveFeed(url, row.stale ? {} : { etag: row.etag, lastModified: row.last_modified })
      : { kind: 'failed' as const };
    if (r.kind === 'read') {
      modified += 1;
      const v = liveFeedVerdict(r.items);
      await pool.query(
        `update live_feeds
            set checked_at = now(), read_at = now(), read_failures = 0,
                etag = $2, last_modified = $3,
                always_on = $4, has_live = $5, has_pending = $6, any_item = $7,
                last_item_at = case when $7 then now() else last_item_at end
          where feed_id = $1`,
        [row.feed_id, r.etag ?? null, r.lastModified ?? null, v.alwaysOn, v.hasLive, v.hasPending, r.anyLiveItem],
      );
    } else if (r.kind === 'not-modified') {
      notModified += 1;
      // The body the last full read saw is unchanged, so what it found still holds.
      await pool.query(
        `update live_feeds
            set checked_at = now(), read_failures = 0,
                last_item_at = case when any_item then now() else last_item_at end
          where feed_id = $1`,
        [row.feed_id],
      );
    } else {
      failed += 1;
      await pool.query(
        `update live_feeds set checked_at = now(), read_failures = read_failures + 1 where feed_id = $1`,
        [row.feed_id],
      );
    }
  });
  return { checked: due.length, notModified, modified, failed };
}
