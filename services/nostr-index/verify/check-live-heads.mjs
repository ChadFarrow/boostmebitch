// `live_heads` against the query it replaced.
//
// Needs a database: DATABASE_URL=... node --experimental-strip-types verify/check-live-heads.mjs
//
// /feed/live used to dedupe every kind:30311 version at READ time. It now reads
// one row per broadcast that INGEST keeps current (007_live_heads.sql), and the
// risk of that move is a head that drifts from what the old query would have
// served: a version that arrived out of order, a head a kind:5 deleted, a `d`
// in an odd place. So the oracle here is the OLD QUERY, verbatim, and every case
// goes through the SHIPPING `ingestEvent` and is then compared with it. A
// hand-written expected list would only restate what this file's author
// believed.
//
// The last two sections pin the statement timeout: the API's pool cancels a
// statement the proxy can no longer use, the route answers 503, and the
// indexer's pool has no such cap.

import { readFileSync } from 'node:fs';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import pg from 'pg';
import { getPool, closePool, createApiPool, API_STATEMENT_TIMEOUT_MS } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import { ingestEvent, emptyStats } from '../src/store.ts';
import { liveStreams } from '../src/queries.ts';
import { liveHeadAddress } from '../src/ingest.ts';
import { buildApi } from '../src/api.ts';

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

const db = getPool(DATABASE_URL);
await migrate(DATABASE_URL);
await db.query('truncate events, event_tags, profiles, tracked_pubkeys, pi_queue, pi_podcasts, pi_episodes, indexer_state, deletion_requests, live_heads cascade');

const NOW = Math.floor(Date.now() / 1000);
const WINDOW = 7 * 86_400;
const stats = emptyStats();
const ingest = (e) => ingestEvent(db, e, stats);

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
async function newLive(limit, since) {
  return (await liveStreams(db, limit, since)).map((r) => r.id).sort();
}
/** Same SET of broadcasts as the old query, with a limit no case reaches, so
 *  a tie on `created_at` at the cut cannot make two right answers differ. */
async function matchesOld(what) {
  const since = NOW - WINDOW;
  eq(await newLive(10_000, since), await oldLive(10_000, since), `${what} — live_heads serves what the old query served`);
}

function live(sk, created_at, tags) {
  return finalizeEvent({ kind: 30311, created_at, content: '', tags }, sk);
}
const del = (sk, ids) => finalizeEvent({ kind: 5, created_at: NOW, content: '', tags: ids.map((id) => ['e', id]) }, sk);
const ids = async () => (await newLive(10_000, NOW - WINDOW));

// --- liveHeadAddress, the pure half ----------------------------------------
{
  const sk = generateSecretKey();
  eq(liveHeadAddress(live(sk, NOW, [['d', 'a'], ['status', 'live']])), 'a', 'the d value is the address');
  eq(liveHeadAddress(live(sk, NOW, [['status', 'live'], ['title', 't'], ['d', 'b']])), 'b',
     'a d behind a status and a title still counts — position 0 is not the rule');
  eq(liveHeadAddress(live(sk, NOW, [['d', ''], ['d', 'c'], ['status', 'planned']])), 'c',
     'an empty d is skipped, as event_tags skips it');
  eq(liveHeadAddress(live(sk, NOW, [['d', 'first'], ['d', 'second'], ['status', 'live']])), 'first',
     'with two d tags the first names the address');
  const dless = live(sk, NOW, [['status', 'live']]);
  eq(liveHeadAddress(dless), dless.id, 'with no d the event id is the address');
  eq(liveHeadAddress(live(sk, NOW, [['d', 'x'], ['status', 'ended']])), null, 'an ended version is never a head');
  eq(liveHeadAddress(live(sk, NOW, [['d', 'x']])), null, 'a version with no status is never a head');
  eq(liveHeadAddress(live(sk, NOW, [['d', 'x'], ['status', 'LIVE']])), null, 'the status match is exact, as the SQL was');
  eq(liveHeadAddress(live(sk, NOW, [['d', 'x'], ['status', 'ended'], ['status', 'live']])), 'x',
     'ANY live status tag qualifies, as the old `exists` did');
  eq(liveHeadAddress(finalizeEvent({ kind: 1, created_at: NOW, content: '', tags: [['status', 'live']] }, sk)), null,
     'only kind:30311 has a head');
}

// --- out-of-order arrival -----------------------------------------------------
{
  const sk = generateSecretKey();
  const v1 = live(sk, NOW - 300, [['d', 'ooo'], ['status', 'live']]);
  const v2 = live(sk, NOW - 200, [['d', 'ooo'], ['status', 'live']]);
  const v3 = live(sk, NOW - 100, [['d', 'ooo'], ['status', 'live']]);
  for (const e of [v3, v1, v2]) await ingest(e);
  const got = await ids();
  ok(got.includes(v3.id) && !got.includes(v1.id) && !got.includes(v2.id),
     'the newest version wins although it arrived first — created_at, never arrival order');
  await matchesOld('out of order');
}

// --- the newest version says `ended` ------------------------------------------
{
  const sk = generateSecretKey();
  const on = live(sk, NOW - 300, [['d', 'end'], ['status', 'live']]);
  const off = live(sk, NOW - 100, [['d', 'end'], ['status', 'ended']]);
  await ingest(on);
  await ingest(off);
  ok((await ids()).includes(on.id),
     'an ended newest version leaves the newest LIVE one as the head — the old per-version filter, kept');
  await matchesOld('ended newest');
}

// --- kind:5 removes the head ---------------------------------------------------
{
  const sk = generateSecretKey();
  const v1 = live(sk, NOW - 300, [['d', 'gone'], ['status', 'live']]);
  const v2 = live(sk, NOW - 200, [['d', 'gone'], ['status', 'planned']]);
  const v3 = live(sk, NOW - 100, [['d', 'gone'], ['status', 'ended']]);
  for (const e of [v1, v2, v3]) await ingest(e);
  ok((await ids()).includes(v2.id), 'the planned version is the head before the delete');
  await ingest(del(sk, [v2.id]));
  ok((await ids()).includes(v1.id), 'deleting the head promotes the next-newest SERVABLE version, skipping the ended one');
  await matchesOld('head deleted, one left');
  await ingest(del(sk, [v1.id]));
  ok(!(await ids()).some((id) => [v1.id, v2.id, v3.id].includes(id)), 'with nothing servable left the broadcast leaves the list');
  await matchesOld('head deleted, none left');
}

// --- a kind:5 for a non-head version, and one from a stranger -----------------
{
  const sk = generateSecretKey();
  const v1 = live(sk, NOW - 300, [['d', 'keep'], ['status', 'live']]);
  const v2 = live(sk, NOW - 100, [['d', 'keep'], ['status', 'live']]);
  await ingest(v1);
  await ingest(v2);
  await ingest(del(sk, [v1.id]));
  ok((await ids()).includes(v2.id), 'deleting an older version leaves the head alone');
  await ingest(del(generateSecretKey(), [v2.id]));
  ok((await ids()).includes(v2.id), 'a kind:5 from another pubkey deletes nothing');
  await matchesOld('non-head delete');
}

// --- the kind:5 arrives BEFORE the version it deletes --------------------------
{
  const sk = generateSecretKey();
  const v1 = live(sk, NOW - 300, [['d', 'pre'], ['status', 'live']]);
  const v2 = live(sk, NOW - 100, [['d', 'pre'], ['status', 'live']]);
  await ingest(del(sk, [v2.id]));
  await ingest(v2);
  await ingest(v1);
  const got = await ids();
  ok(got.includes(v1.id) && !got.includes(v2.id), 'a version stored tombstoned never becomes a head');
  await matchesOld('pre-deleted');
}

// --- addresses: no d, several d, an empty d, a d out of position -------------
{
  const sk = generateSecretKey();
  const a = live(sk, NOW - 300, [['status', 'live'], ['title', 'one']]);
  const b = live(sk, NOW - 200, [['status', 'live'], ['title', 'two']]);
  await ingest(a);
  await ingest(b);
  const got = await ids();
  ok(got.includes(a.id) && got.includes(b.id), 'two d-less broadcasts from one host are two rows');
  await ingest(del(sk, [b.id]));
  ok((await ids()).includes(a.id) && !(await ids()).includes(b.id), 'deleting one d-less broadcast leaves the other');

  const m1 = live(sk, NOW - 300, [['d', 'A'], ['d', 'B'], ['status', 'live']]);
  const m2 = live(sk, NOW - 200, [['d', 'B'], ['status', 'live']]);
  const e1 = live(sk, NOW - 250, [['d', ''], ['d', 'C'], ['status', 'live']]);
  const e2 = live(sk, NOW - 150, [['title', 'x'], ['status', 'live'], ['d', 'C']]);
  for (const e of [m1, m2, e1, e2]) await ingest(e);
  const got2 = await ids();
  ok(got2.includes(m1.id) && got2.includes(m2.id), 'a version whose FIRST d is A is not a version of B');
  ok(got2.includes(e2.id) && !got2.includes(e1.id), 'an empty first d and a late d both resolve to C, so they dedupe');
  await matchesOld('address shapes');
  // m1 carries `d B` too, but second. Deleting B's only real version must not
  // promote m1 to be B's head as well as A's.
  await ingest(del(sk, [m2.id]));
  const got3 = await ids();
  eq(got3.filter((id) => id === m1.id).length, 1, 'a version is promoted only to the address its FIRST d names');
  ok(!got3.includes(m2.id), 'and B leaves the list');
  await matchesOld('promotion respects the first d');

  // The odd shape the promotion pre-filter must not drop: a d-less version
  // (address = its own id) and a later version whose `d` IS that id. The old
  // query read them as one broadcast, so deleting the later one serves the
  // d-less one again.
  const x = live(sk, NOW - 400, [['status', 'live'], ['title', 'dless']]);
  const y = live(sk, NOW - 90, [['d', x.id], ['status', 'live']]);
  await ingest(x);
  await ingest(y);
  ok((await ids()).includes(y.id) && !(await ids()).includes(x.id), 'a d equal to a d-less id joins that broadcast');
  await ingest(del(sk, [y.id]));
  ok((await ids()).includes(x.id), 'and deleting it promotes the d-less version');
  await matchesOld('d equal to a d-less id');

  // Several tags hold the address string but none is the first `d`: the
  // pre-filter lets this row through and the first-d test must still refuse it.
  const z1 = live(sk, NOW - 500, [['d', 'Z'], ['status', 'live']]);
  const z2 = live(sk, NOW - 80, [['d', 'Z'], ['status', 'live']]);
  const decoy = live(sk, NOW - 85, [['d', 'other-z'], ['Z', 'd'], ['x', 'd', 'Z'], ['status', 'live']]);
  for (const e of [z1, z2, decoy]) await ingest(e);
  await ingest(del(sk, [z2.id]));
  const gotZ = await ids();
  ok(gotZ.includes(z1.id), 'the older real version of Z is promoted');
  eq(gotZ.filter((id) => id === decoy.id).length, 1, 'a decoy holding "d" and "Z" in other tags is not promoted to Z');
  await matchesOld('pre-filter decoy');
}

// --- the window -------------------------------------------------------------------
{
  const sk = generateSecretKey();
  const old = live(sk, NOW - 30 * 86_400, [['d', 'old'], ['status', 'live']]);
  await ingest(old);
  ok(!(await ids()).includes(old.id), 'a head older than the window is held but not served');
  const fresh = live(sk, NOW - 60, [['d', 'old'], ['status', 'live']]);
  await ingest(fresh);
  ok((await ids()).includes(fresh.id), 'a new version of an old broadcast becomes its head and is served');
  await matchesOld('window');
}

// --- a version stored WITHOUT a head is repaired when it is offered again -----
// The deploy overlap: the old process stores a version and writes no head. The
// next live re-subscribe offers it again, and the upsert must not need a new
// insert to fire.
{
  const sk = generateSecretKey();
  const v = live(sk, NOW - 50, [['d', 'heal'], ['status', 'live']]);
  await ingest(v);
  await db.query('delete from live_heads where event_id = $1', [v.id]);
  ok(!(await ids()).includes(v.id), 'precondition: the head is missing');
  await ingest(v);
  ok((await ids()).includes(v.id), 'offering a stored version again restores its head');
  const older = live(sk, NOW - 500, [['d', 'heal'], ['status', 'live']]);
  await ingest(older);
  ok((await ids()).includes(v.id) && !(await ids()).includes(older.id), 'and offering an OLDER one never moves a head back');
  await matchesOld('re-offer');
}

// --- random replay against the oracle -----------------------------------------
// Many versions over few addresses, statuses and d layouts mixed, arrival order
// shuffled, deletions interleaved. A deterministic PRNG so a failure repeats.
{
  let seed = 0x5eed;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const hosts = Array.from({ length: 4 }, () => generateSecretKey());
  const statuses = ['live', 'live', 'live', 'planned', 'ended', null];
  const events = [];
  for (let i = 0; i < 400; i++) {
    const sk = pick(hosts);
    const d = pick(['s1', 's2', 's3', 's4', null]);
    const status = pick(statuses);
    const created = NOW - Math.floor(rnd() * 10 * 86_400);
    const tags = [];
    const dTags = d === null ? [] : rnd() < 0.15 ? [['d', ''], ['d', d]] : rnd() < 0.1 ? [['d', d], ['d', 'other']] : [['d', d]];
    if (rnd() < 0.5) tags.push(...dTags);
    if (status) tags.push(['status', status]);
    tags.push(['title', `v${i}`]);
    if (!tags.some((t) => t[0] === 'd')) tags.push(...dTags);
    events.push({ sk, e: live(sk, created, tags) });
  }
  for (let i = events.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [events[i], events[j]] = [events[j], events[i]];
  }
  let deletes = 0;
  for (let i = 0; i < events.length; i++) {
    await ingest(events[i].e);
    if (rnd() < 0.08) {
      const target = pick(events.slice(0, i + 1).filter((x) => x.sk === events[i].sk));
      await ingest(del(target.sk, [target.e.id]));
      deletes++;
    }
    if (i % 100 === 99) await matchesOld(`random replay after ${i + 1} versions`);
  }
  // And a delete aimed only at current heads, so promotion is exercised hard.
  const { rows } = await db.query('select event_id from live_heads');
  for (const { event_id } of rows.slice(0, 20)) {
    const owner = events.find((x) => x.e.id === event_id);
    if (owner) { await ingest(del(owner.sk, [event_id])); deletes++; }
  }
  await matchesOld(`random replay, ${deletes} deletions`);
}

// --- the migration's backfill agrees with ingest ------------------------------
// The backfill is the old query; ingest is new code. Rebuilding the table from
// the backfill alone must give the same heads that ingest maintained.
{
  const since = NOW - WINDOW;
  const before = await newLive(10_000, since);
  const sql = readFileSync(new URL('../migrations/007_live_heads.sql', import.meta.url), 'utf8');
  const backfill = sql.slice(sql.indexOf('insert into live_heads'));
  await db.query('truncate live_heads');
  await db.query(backfill);
  eq(await newLive(10_000, since), before, 'the 007 backfill rebuilds exactly the heads ingest kept');
}

// --- the API pool cancels a statement the proxy has stopped waiting for --------
{
  const pgClient = new pg.Client({ connectionString: DATABASE_URL });
  await pgClient.connect();
  const shortMs = 400;
  const apiDb = createApiPool(DATABASE_URL, shortMs);
  const app = buildApi(apiDb, { apiKey: 'k', piTtlHours: 168, piMissTtlHours: 1 });
  await app.ready();

  // Hold a lock the live query needs, so it runs past the cap however fast
  // the machine is.
  await pgClient.query('begin');
  await pgClient.query('lock table live_heads in access exclusive mode');
  const t0 = Date.now();
  const res = await app.inject({ method: 'GET', url: '/feed/live', headers: { 'x-index-key': 'k' } });
  const took = Date.now() - t0;
  eq(res.statusCode, 503, 'a cancelled statement answers 503, not 500');
  eq(res.json(), { error: 'index query timed out' }, 'and the body names the cause without the database message');
  ok(took < shortMs + 1_500, `the route answered at the cap, not when the lock went (${took} ms)`);
  const { rows: waiting } = await pgClient.query(
    `select count(*)::int as n from pg_stat_activity
      where state = 'active' and query like '%from live_heads h%' and pid <> pg_backend_pid()`,
  );
  eq(waiting[0].n, 0, 'nothing is left running on the database after the 503');
  await pgClient.query('rollback');

  const after = await app.inject({ method: 'GET', url: '/feed/live', headers: { 'x-index-key': 'k' } });
  eq(after.statusCode, 200, 'the same pool answers again once the database does');

  const { rows: apiSetting } = await apiDb.query('show statement_timeout');
  eq(apiSetting[0].statement_timeout, `${shortMs}ms`, 'the API pool carries the cap');
  const { rows: idxSetting } = await db.query('show statement_timeout');
  eq(idxSetting[0].statement_timeout, '0', 'the indexer pool does not — a backfill page may rightly run long');
  ok(API_STATEMENT_TIMEOUT_MS < 6_000, 'the shipped cap is under the app proxy\'s 6 s');

  await app.close();
  await apiDb.end();
  await pgClient.end();
}

await closePool();
console.log('ingest:', JSON.stringify(stats));
console.log(`\n${checks} checks`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
console.log('ok');
