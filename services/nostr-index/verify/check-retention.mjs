// The kind:30311 retention (src/retention.ts) against what it must never
// change.
//
// Needs a database: DATABASE_URL=... node --experimental-strip-types verify/check-retention.mjs
//
// The risk of a delete is a reader losing a row it could still reach. So the
// oracle for /feed/live is the read-time query the route ran before 007, copied
// verbatim from check-live-heads.mjs: its answer must be the same before and
// after a prune, and after a kind:5 promotion that follows one. The other
// sections pin each row the prune must keep (a head, a referenced version, a
// tombstoned version, every other kind, everything inside the window) and the
// pacing: the batch bound, the cursor, the WAL waits, the lock and the stop.

import { execFileSync } from 'node:child_process';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { getPool, closePool } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import { ingestEvent, emptyStats } from '../src/store.ts';
import { liveStreams } from '../src/queries.ts';
import { LIVE_WINDOW_SECS } from '../src/ingest.ts';
import {
  LIVE_RETENTION_SECS, MAX_WAL_WAITS, PRUNE_LOCK_KEY, WAL_SINCE_REDO_CEILING,
  pruneLiveBatch, pruneLiveVersions, retentionCutoff, sampleWal, walVerdict,
} from '../src/retention.ts';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

let failures = 0;
let checks = 0;
function ok(cond, what) {
  checks++;
  if (!cond) { failures++; console.error(`FAIL ${what}`); }
}
function eq(actual, expected, what) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${what}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
}

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const CUTOFF = NOW - LIVE_RETENTION_SECS;
const noNap = async () => {};
const quiet = async () => ({ sinceRedo: 0 });

// --- the pure half -------------------------------------------------------------
{
  eq(LIVE_RETENTION_SECS, LIVE_WINDOW_SECS + DAY, 'the retention is the live window plus one day, derived');
  ok(LIVE_RETENTION_SECS > LIVE_WINDOW_SECS, 'the retention is longer than the window the route and the promotion read');
  eq(retentionCutoff(NOW), NOW - LIVE_RETENTION_SECS, 'the cutoff is now minus the retention');
  eq(retentionCutoff(NOW + 0.9), NOW - LIVE_RETENTION_SECS, 'a fractional clock floors');
  eq(walVerdict(null), 'stop', 'an unmeasured WAL stops the run');
  eq(walVerdict({ sinceRedo: Number.NaN }), 'stop', 'a WAL reading that is not a number stops the run');
  eq(walVerdict({ sinceRedo: 0 }), 'go', 'a quiet WAL lets a batch run');
  eq(walVerdict({ sinceRedo: WAL_SINCE_REDO_CEILING }), 'go', 'the ceiling itself still runs');
  eq(walVerdict({ sinceRedo: WAL_SINCE_REDO_CEILING + 1 }), 'wait', 'above the ceiling the run waits');
}

// --- INDEX_LIVE_PRUNE is validated, not cast -----------------------------------
{
  const configUrl = new URL('../src/config.ts', import.meta.url).href;
  const read = (value) => {
    const env = { ...process.env, DATABASE_URL: 'postgres://x', INDEX_API_KEY: 'k' };
    if (value === undefined) delete env.INDEX_LIVE_PRUNE; else env.INDEX_LIVE_PRUNE = value;
    try {
      return execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e',
        `const { config } = await import(${JSON.stringify(configUrl)}); console.log(String(config.livePrune));`],
        { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch {
      return 'threw';
    }
  };
  eq(read(undefined), 'true', 'unset INDEX_LIVE_PRUNE prunes');
  eq(read('on'), 'true', 'INDEX_LIVE_PRUNE=on prunes');
  eq(read('off'), 'false', 'INDEX_LIVE_PRUNE=off keeps every version');
  eq(read('OFF'), 'threw', 'any other value refuses to start rather than becoming a guess');
}

const db = getPool(DATABASE_URL);
await migrate(DATABASE_URL);
await db.query('truncate events, event_tags, profiles, tracked_pubkeys, pi_queue, pi_podcasts, pi_episodes, indexer_state, deletion_requests, live_heads cascade');

const stats = emptyStats();
const ingest = (e) => ingestEvent(db, e, stats);
const live = (sk, created_at, tags) => finalizeEvent({ kind: 30311, created_at, content: 'x'.repeat(200), tags }, sk);
const note = (sk, kind, created_at, tags) => finalizeEvent({ kind, created_at, content: '', tags }, sk);
const exists = async (id) => (await db.query('select 1 from events where id = $1', [id])).rowCount === 1;
const tagRows = async (id) => Number((await db.query('select count(*) from event_tags where event_id = $1', [id])).rows[0].count);

/** The read-time query /feed/live ran before 007, copied verbatim. */
async function oldLive(limit, since) {
  const { rows } = await db.query(
    `select id from (
       select distinct on (e.pubkey, coalesce(d.value, e.id))
              e.id, e.pubkey, e.kind, e.created_at, e.content, e.tags, e.sig
         from events e
         left join lateral (
           select t.value from event_tags t
            where t.event_id = e.id and t.name = 'd'
            order by t.pos limit 1
         ) d on true
        where e.kind = 30311 and e.deleted_at is null and e.created_at >= $2
          and exists (select 1 from jsonb_array_elements(e.tags) tag
                       where tag->>0 = 'status' and tag->>1 in ('live', 'planned'))
        order by e.pubkey, coalesce(d.value, e.id), e.created_at desc
     ) e
     order by e.created_at desc
     limit $1`,
    [limit, since],
  );
  return rows.map((r) => r.id).sort();
}
const servedNow = async () => (await liveStreams(db, 10_000, NOW - LIVE_WINDOW_SECS)).map((r) => r.id).sort();

// --- what goes and what stays ---------------------------------------------------
const A = generateSecretKey(); // a broadcast with old, in-window and head versions
const B = generateSecretKey(); // a broadcast that ended: its head is old
const C = generateSecretKey(); // old versions something else names
const D = generateSecretKey(); // an old version its author deleted
const tagsOf = (d, status = 'live') => [['d', d], ['status', status], ['p', 'a'.repeat(64)], ['t', 'music'], ['title', 'x']];

const a10 = live(A, NOW - 10 * DAY, tagsOf('a'));
const a9 = live(A, NOW - 9 * DAY, tagsOf('a'));
const aCut = live(A, CUTOFF, tagsOf('a'));          // exactly at the cutoff: stays
const aCutMinus = live(A, CUTOFF - 1, tagsOf('a')); // one second older: goes
const a6 = live(A, NOW - 6 * DAY, tagsOf('a'));     // inside the window, not the head
const a2 = live(A, NOW - 2 * DAY, tagsOf('a'));     // the head
const b10 = live(B, NOW - 10 * DAY, tagsOf('b'));
const b9 = live(B, NOW - 9.5 * DAY, tagsOf('b'));   // the head, older than the cutoff
const bEnded = live(B, NOW - 9 * DAY, tagsOf('b', 'ended')); // newest, but never a head
const cQuoted = live(C, NOW - 20 * DAY, tagsOf('c'));
const cZapped = live(C, NOW - 19 * DAY, tagsOf('c'));
const cPlain = live(C, NOW - 18 * DAY, tagsOf('c'));
const cHead = live(C, NOW - 1 * DAY, tagsOf('c'));
const d10 = live(D, NOW - 10 * DAY, tagsOf('d'));
const dHead = live(D, NOW - 1 * DAY, tagsOf('d'));
const someone = generateSecretKey();
const quoting = note(someone, 1, NOW - 15 * DAY, [['q', cQuoted.id], ['k', 'podcast:guid']]);
const zap = note(someone, 9735, NOW - 15 * DAY, [['e', cZapped.id], ['p', 'b'.repeat(64)]]);
const oldNote = note(someone, 1, NOW - 30 * DAY, [['t', 'boostagram']]);
const oldRepost = note(someone, 6, NOW - 30 * DAY, [['e', oldNote.id]]);
const oldZap = note(someone, 9735, NOW - 30 * DAY, [['p', 'c'.repeat(64)]]);

for (const e of [a10, a9, aCut, aCutMinus, a6, a2, b10, b9, bEnded, cQuoted, cZapped, cPlain, cHead, d10, dHead,
  quoting, zap, oldNote, oldRepost, oldZap]) await ingest(e);
await ingest(finalizeEvent({ kind: 5, created_at: NOW, content: '', tags: [['e', d10.id]] }, D));

{
  const before = await servedNow();
  eq(before, await oldLive(10_000, NOW - LIVE_WINDOW_SECS), 'before the prune, live_heads serves what the old query served');
  ok((await tagRows(a10.id)) > 0, 'a pruned version has tag rows before the prune');

  const run = await pruneLiveVersions(db, { nowSecs: NOW, sleep: noNap, sampleWal: quiet });
  eq(run.end, 'caught-up', 'the run ends caught up');
  eq(run.cutoff, CUTOFF, 'the run reports its cutoff');

  for (const [e, what] of [[a10, 'a 10-day-old version'], [a9, 'a 9-day-old version'], [aCutMinus, 'a version one second past the cutoff'],
    [b10, 'an old version behind an old head'], [bEnded, 'an old ended version'], [cPlain, 'an old version nothing names']]) {
    ok(!(await exists(e.id)), `${what} is deleted`);
    eq(await tagRows(e.id), 0, `${what} loses its tag rows with it (the cascade)`);
  }
  eq(run.deleted, 6, 'the run deleted exactly the six prunable versions');

  for (const [e, what] of [[aCut, 'a version exactly at the cutoff'], [a6, 'a version inside the window that is not the head'],
    [a2, 'a head inside the window'], [b9, 'a head older than the cutoff'], [cQuoted, 'an old version a note quotes with q'],
    [cZapped, 'an old version a zap names with e'], [cHead, 'a fresh head'], [d10, 'an old tombstoned version'],
    [oldNote, 'an old kind:1'], [oldRepost, 'an old kind:6'], [oldZap, 'an old kind:9735'], [quoting, 'the quoting note'], [zap, 'the zap']]) {
    ok(await exists(e.id), `${what} stays`);
  }
  ok((await tagRows(cQuoted.id)) > 0, 'a kept version keeps its tag rows');

  eq(await servedNow(), before, 'after the prune, /feed/live serves exactly what it served before');
  eq(await servedNow(), await oldLive(10_000, NOW - LIVE_WINDOW_SECS), 'after the prune, live_heads still matches the old query');

  // A kind:5 that removes a head after a prune: the promotion must find the
  // in-window version the prune kept, exactly as the old query would.
  await ingest(finalizeEvent({ kind: 5, created_at: NOW, content: '', tags: [['e', a2.id]] }, A));
  const promoted = await servedNow();
  ok(promoted.includes(a6.id) && !promoted.includes(a2.id), 'a kind:5 on the head promotes the kept in-window version');
  eq(promoted, await oldLive(10_000, NOW - LIVE_WINDOW_SECS), 'after a prune and a promotion, live_heads matches the old query');

  const again = await pruneLiveVersions(db, { nowSecs: NOW, sleep: noNap, sampleWal: quiet });
  eq(again.deleted, 0, 'a second run over the same data deletes nothing');
  eq(again.batches, 1, 'and costs one batch');
}

// --- paging: the batch bound and the cursor ---------------------------------------
{
  const E = generateSecretKey();
  const N = 1_234;
  const rows = [];
  // Twenty share each second, so the cursor's ties on created_at are exercised.
  // A distinct title each, or two rows with the same second, d and key are the
  // same event id and the insert keeps one.
  for (let i = 0; i < N; i++) {
    rows.push(live(E, NOW - 30 * DAY + Math.floor(i / 20), [['d', `e${i % 7}`], ['status', 'live'], ['title', `v${i}`]]));
  }
  for (const e of rows) await ingest(e);
  const kept = Number((await db.query(
    `select count(*) from live_heads h join events e on e.id = h.event_id where e.pubkey = $1`, [rows[0].pubkey])).rows[0].count);

  const one = await pruneLiveBatch(db, CUTOFF, 0, 7);
  eq(one.locked, false, 'a batch with the lock free is not locked');
  eq(one.createdAt.length, 7, 'one batch deletes exactly its limit when more is there');

  const run = await pruneLiveVersions(db, { nowSecs: NOW, batch: 100, sleep: noNap, sampleWal: quiet });
  eq(run.deleted, N - 7 - kept, 'paging deletes every prunable version, ties on created_at included');
  eq(run.batches, Math.floor((N - 7 - kept) / 100) + 1, 'and takes one batch per 100 plus the short last one');
  const left = Number((await db.query(`select count(*) from events where pubkey = $1`, [rows[0].pubkey])).rows[0].count);
  eq(left, kept, 'only the heads of that host remain');
}

// --- pacing: WAL waits, an unmeasured WAL, the lock, the stop ----------------------
{
  const F = generateSecretKey();
  const fresh = [];
  for (let i = 0; i < 30; i++) fresh.push(live(F, NOW - 40 * DAY + i, tagsOf('f')));
  for (const e of fresh) await ingest(e);
  const prunable = async () => Number((await db.query(
    `select count(*) from events e where e.pubkey = $1
        and not exists (select 1 from live_heads h where h.event_id = e.id)`, [fresh[0].pubkey])).rows[0].count);
  const start = await prunable();
  ok(start === 29, 'thirty versions, one of them the head');

  const unmeasured = await pruneLiveVersions(db, { nowSecs: NOW, sleep: noNap, sampleWal: async () => null });
  eq([unmeasured.end, unmeasured.deleted], ['wal-unmeasured', 0], 'with no WAL reading nothing is deleted');

  const busy = await pruneLiveVersions(db, {
    nowSecs: NOW, sleep: noNap, sampleWal: async () => ({ sinceRedo: WAL_SINCE_REDO_CEILING + 1 }),
  });
  eq([busy.end, busy.deleted, busy.walWaits], ['wal-busy', 0, MAX_WAL_WAITS + 1], 'a WAL that stays busy ends the run after the last wait, with nothing deleted');

  let calls = 0;
  const naps = [];
  const paced = await pruneLiveVersions(db, {
    nowSecs: NOW, batch: 10, pauseMs: 7, walWaitMs: 11,
    sleep: async (ms) => { naps.push(ms); },
    sampleWal: async () => (++calls <= 2 ? { sinceRedo: WAL_SINCE_REDO_CEILING + 1 } : { sinceRedo: 0 }),
  });
  eq(paced.walWaits, 2, 'two busy readings are two waits');
  eq(paced.deleted, start, 'then the run goes on and deletes everything prunable');
  eq(naps.slice(0, 2), [11, 11], 'a wait sleeps the WAL wait');
  ok(naps.slice(2).every((ms) => ms === 7), 'between batches it sleeps the pause');

  for (let i = 0; i < 5; i++) await ingest(live(F, NOW - 39 * DAY + i, tagsOf('f')));
  const holder = await db.connect();
  await holder.query('begin');
  await holder.query('select pg_advisory_xact_lock($1)', [PRUNE_LOCK_KEY]);
  const locked = await pruneLiveVersions(db, { nowSecs: NOW, sleep: noNap, sampleWal: quiet });
  eq([locked.end, locked.deleted], ['locked', 0], 'with another process holding the lock this one deletes nothing');

  // A row another transaction holds is skipped, never waited for.
  await holder.query('rollback');
  const target = (await db.query(
    `select e.id from events e where e.pubkey = $1 and e.created_at < $2
        and not exists (select 1 from live_heads h where h.event_id = e.id) order by created_at limit 1`,
    [fresh[0].pubkey, CUTOFF])).rows[0].id;
  await holder.query('begin');
  await holder.query('select 1 from events where id = $1 for update', [target]);
  const t0 = Date.now();
  const skipped = await pruneLiveVersions(db, { nowSecs: NOW, sleep: noNap, sampleWal: quiet });
  ok(Date.now() - t0 < 4_000, 'a locked row does not make the prune wait');
  eq(skipped.deleted, 4, 'the other versions go');
  ok(await exists(target), 'the locked version stays for the next run');
  await holder.query('rollback');
  holder.release();
  const later = await pruneLiveVersions(db, { nowSecs: NOW, sleep: noNap, sampleWal: quiet });
  eq(later.deleted, 1, 'the next run deletes it');

  await ingest(live(F, NOW - 38 * DAY, tagsOf('f')));
  const stopped = await pruneLiveVersions(db, { nowSecs: NOW, sleep: noNap, sampleWal: quiet, shouldStop: () => true });
  eq([stopped.end, stopped.deleted], ['stopped', 0], 'a stopped process deletes nothing more');
}

// --- the real WAL reading ------------------------------------------------------------
{
  const s = await sampleWal(db);
  ok(s !== null && Number.isFinite(s.sinceRedo) && s.sinceRedo >= 0, 'sampleWal reads the WAL since the last checkpoint on this database');
}

await closePool();
if (failures) {
  console.error(`check-retention: ${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`check-retention: ok (${checks} checks)`);
