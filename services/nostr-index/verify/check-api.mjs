// End-to-end check of the read API against a real Postgres.
//
// Needs a database: DATABASE_URL=... node --experimental-strip-types verify/check-api.mjs
// It creates its own schema via the migration runner, seeds signed events
// through the SHIPPING ingest path, and then asks the SHIPPING API for them.
// Nothing here reimplements a query.
//
// Seeded data is a small but real shape: a root boost with a two-deep reply
// chain, a quote, a repost by a viewer, a zap receipt, and a note that a kind:5
// tombstones. The tombstone is the one that matters - a deleted note must be
// absent from EVERY endpoint, and "absent from the one I remembered to check"
// is how it comes back on the others.

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { getPool, closePool } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import { ingestEvent, emptyStats } from '../src/store.ts';
import { buildApi } from '../src/api.ts';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const API_KEY = 'test-key';
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
// Fresh every run: a check that depends on leftovers from the last one is not
// a check.
await db.query('truncate events, event_tags, profiles, tracked_pubkeys, pi_queue, pi_podcasts, pi_episodes, indexer_state cascade');

const AUTHOR = generateSecretKey();
const AUTHOR_PK = getPublicKey(AUTHOR);
const REPLIER = generateSecretKey();
const REPLIER_PK = getPublicKey(REPLIER);
const VIEWER = generateSecretKey();
const VIEWER_PK = getPublicKey(VIEWER);
const ARTIST_PK = 'ab'.repeat(32);
const FEED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ITEM = 'item-123';
const NOW = Math.floor(Date.now() / 1000);

const sign = (tpl, sk = AUTHOR) => finalizeEvent({ created_at: NOW, content: '', tags: [], ...tpl }, sk);

const root = sign({
  kind: 1, created_at: NOW - 100, content: 'Boosted 100 sats to the show',
  tags: [['k', 'podcast:guid'], ['i', `podcast:guid:${FEED}`], ['p', ARTIST_PK], ['t', 'boostagram']],
});
const trackNote = sign({
  kind: 1, created_at: NOW - 90, content: 'Boosted a track',
  tags: [['k', 'podcast:item:guid'], ['i', `podcast:guid:${FEED}`], ['i', `podcast:item:guid:${ITEM}`]],
});
const quoted = sign({ kind: 1, created_at: NOW - 200, content: 'the quoted note', tags: [] });
const quoter = sign({
  kind: 1, created_at: NOW - 80, content: 'quoting that',
  tags: [['k', 'podcast:guid'], ['i', `podcast:guid:${FEED}`], ['q', quoted.id]],
});
const reply1 = sign({ kind: 1, created_at: NOW - 50, content: 'reply one', tags: [['e', root.id, '', 'root'], ['p', AUTHOR_PK]] }, REPLIER);
const reply2 = sign({ kind: 1, created_at: NOW - 40, content: 'reply two', tags: [['e', root.id, '', 'root'], ['e', reply1.id, '', 'reply']] });
const repost = sign({ kind: 6, created_at: NOW - 30, content: '', tags: [['e', root.id], ['p', AUTHOR_PK]] }, VIEWER);
const zap = sign({ kind: 9735, created_at: NOW - 20, content: '', tags: [['p', ARTIST_PK], ['P', AUTHOR_PK], ['bolt11', 'lnbc1']] });
const doomed = sign({
  kind: 1, created_at: NOW - 10, content: 'this gets deleted',
  tags: [['k', 'podcast:guid'], ['i', `podcast:guid:${FEED}`], ['p', ARTIST_PK], ['e', root.id, '', 'root']],
});
const tombstone = sign({ kind: 5, created_at: NOW, content: '', tags: [['e', doomed.id]] });
const authorProfile = sign({ kind: 0, created_at: NOW, content: JSON.stringify({ name: 'Author', banner: 'https://x/b.png', website: 'https://x' }) });
const replierProfile = sign({ kind: 0, created_at: NOW, content: JSON.stringify({ name: 'Replier' }) }, REPLIER);

const stats = emptyStats();
for (const e of [quoted, root, trackNote, quoter, reply1, reply2, repost, zap, doomed, authorProfile, replierProfile, tombstone]) {
  await ingestEvent(db, e, stats);
}
console.log('seed:', JSON.stringify(stats));
ok(stats.rejected === 0, 'no seed event was rejected');
ok(stats.deleted === 1, 'the tombstone deleted exactly one note');

const app = buildApi(db, { apiKey: API_KEY, piTtlHours: 168 });
await app.ready();

async function get(url) {
  const res = await app.inject({ method: 'GET', url, headers: { 'x-index-key': API_KEY } });
  return { status: res.statusCode, body: res.json() };
}
async function post(url, payload) {
  const res = await app.inject({ method: 'POST', url, payload, headers: { 'x-index-key': API_KEY } });
  return { status: res.statusCode, body: res.json() };
}

// --- auth -------------------------------------------------------------------
{
  const res = await app.inject({ method: 'GET', url: '/feed/global' });
  eq(res.statusCode, 401, 'a request with no key is refused');
  const bad = await app.inject({ method: 'GET', url: '/feed/global', headers: { 'x-index-key': 'wrong' } });
  eq(bad.statusCode, 401, 'a request with the wrong key is refused');
  const health = await app.inject({ method: 'GET', url: '/health' });
  eq(health.statusCode, 200, 'health needs no key');
}

// --- global feed bundle -----------------------------------------------------
{
  const { status, body } = await get('/feed/global?limit=50');
  eq(status, 200, 'global feed answers');
  const ids = body.notes.map((n) => n.id);
  ok(ids.includes(root.id), 'global feed carries the root boost');
  ok(ids.includes(trackNote.id), 'global feed carries the track boost');
  ok(ids.includes(quoter.id), 'global feed carries the quoting note');
  ok(!ids.includes(doomed.id), 'DELETED note is absent from the global feed');
  ok(!ids.includes(quoted.id), 'a note with no podcast k-tag is not in the global feed');
  ok(!ids.includes(reply1.id), 'a reply is not a top-level note');

  // The whole point: replies, quotes and profiles arrive WITH the notes.
  const replyIds = body.replies.map((r) => r.id);
  ok(replyIds.includes(reply1.id) && replyIds.includes(reply2.id), 'both reply depths arrive in the same response');
  ok(!replyIds.includes(doomed.id), 'DELETED note is absent from the reply forest too');
  ok(body.quoted.some((q) => q.id === quoted.id), 'the quoted event arrives in the bundle');
  const profilePks = body.profiles.map((p) => p.pubkey);
  ok(profilePks.includes(AUTHOR_PK) && profilePks.includes(REPLIER_PK), 'author AND reply-author profiles arrive');
  ok(body.indexedThrough > 0, 'indexedThrough is reported');

  // Profiles come back as signed kind:0 EVENTS so the client can verify them,
  // and with their raw content so no field is lost.
  const authorRow = body.profiles.find((p) => p.pubkey === AUTHOR_PK);
  eq(authorRow.kind, 0, 'a profile is returned as a kind:0 event');
  ok(typeof authorRow.sig === 'string' && authorRow.sig.length === 128, 'a profile carries its signature');
  const parsed = JSON.parse(authorRow.content);
  ok(parsed.banner && parsed.website, 'raw profile content survives: banner and website are not dropped');
}

// --- per-show and per-episode ----------------------------------------------
{
  const show = await get(`/feed/podcast/${FEED}`);
  const showIds = show.body.notes.map((n) => n.id);
  ok(showIds.includes(root.id) && showIds.includes(trackNote.id), 'the show feed carries its notes');
  ok(!showIds.includes(doomed.id), 'DELETED note is absent from the show feed');

  const ep = await get(`/feed/episode/${ITEM}`);
  const epIds = ep.body.notes.map((n) => n.id);
  eq(epIds, [trackNote.id], 'the episode feed carries only the note naming that item');
}

// --- by author and mentioning ----------------------------------------------
{
  const sent = await get(`/feed/by-author/${AUTHOR_PK}`);
  const sentIds = sent.body.notes.map((n) => n.id);
  ok(sentIds.includes(root.id), 'boosts-sent carries the author own notes');
  ok(!sentIds.includes(reply1.id), 'a different author note is not in boosts-sent');
  ok(!sentIds.includes(doomed.id), 'DELETED note is absent from boosts-sent');

  const recv = await get(`/feed/mentioning/${ARTIST_PK}`);
  const recvIds = recv.body.notes.map((n) => n.id);
  ok(recvIds.includes(root.id), 'boosts-received carries a note p-tagging the artist');
  ok(!recvIds.includes(doomed.id), 'DELETED note is absent from boosts-received');
  ok(!recvIds.includes(trackNote.id), 'a note that does not p-tag the artist is not in boosts-received');
}

// --- zaps, reposts, profiles ------------------------------------------------
{
  const z = await get(`/zaps/received/${ARTIST_PK}`);
  eq(z.body.receipts.map((r) => r.id), [zap.id], 'the zap receipt is returned for its p-tagged recipient');
  ok(z.body.profiles.some((p) => p.pubkey === AUTHOR_PK), 'the zapper profile rides along');

  const r = await get(`/reposts?pubkey=${VIEWER_PK}&ids=${root.id},${trackNote.id}`);
  eq(r.body.events.map((e) => e.id), [repost.id], 'the viewer own repost is found');
  const none = await get(`/reposts?pubkey=${REPLIER_PK}&ids=${root.id}`);
  eq(none.body.events, [], 'a viewer who has not reposted gets nothing');

  const p = await get(`/profiles?pubkeys=${AUTHOR_PK},${REPLIER_PK},${ARTIST_PK}`);
  eq(p.body.profiles.length, 2, 'only pubkeys we hold a profile for come back');
}

// --- input validation -------------------------------------------------------
{
  eq((await get('/feed/by-author/not-hex')).status, 400, 'a non-hex pubkey is refused');
  eq((await get('/reposts?pubkey=nope')).status, 400, 'a non-hex repost pubkey is refused');
  const capped = await get('/feed/global?limit=99999');
  ok(capped.body.notes.length <= 200, 'limit is capped server-side');
  eq((await post('/pi/podcasts', { guids: 'not-an-array' })).status, 400, 'a non-array guids body is refused');
}

// --- the three-state Podcast Index answer ----------------------------------
//
// This is the contract lib/podcast-meta.ts depends on. Getting it wrong
// reintroduces the negative-cache poisoning bug from the server side.
{
  await db.query(`insert into pi_podcasts (guid, data, miss) values ('found-guid', '{"id":7,"title":"A Show"}'::jsonb, false)`);
  await db.query(`insert into pi_podcasts (guid, data, miss) values ('missing-guid', null, true)`);
  // 'never-asked-guid' is deliberately NOT inserted, and PI is unconfigured in
  // this check, so the endpoint cannot ask about it either.
  const { body } = await post('/pi/podcasts', { guids: ['found-guid', 'missing-guid', 'never-asked-guid'] });

  eq(body['found-guid'], { id: 7, title: 'A Show' }, 'a resolved feed comes back as its data');
  ok('missing-guid' in body && body['missing-guid'] === null, 'PI saying "not found" comes back as an explicit null - it IS an answer and is cacheable');
  ok(!('never-asked-guid' in body), 'a guid we could not ask about is ABSENT from the map, never null');

  await db.query(`insert into pi_episodes (feed_guid, item_guid, data, miss) values ('f1', 'i1', '{"id":9}'::jsonb, false)`);
  const ep = await post('/pi/episodes', { refs: [{ feedGuid: 'f1', itemGuid: 'i1' }, { feedGuid: 'f1', itemGuid: 'unknown' }] });
  eq(ep.body['f1:i1'], { id: 9 }, 'a resolved episode comes back');
  ok(!('f1:unknown' in ep.body), 'an episode we could not ask about is ABSENT, never null');

  // A row past its TTL must read as "not cached", not as a stale answer.
  await db.query(`update pi_podcasts set fetched_at = now() - interval '400 days' where guid = 'found-guid'`);
  const stale = await post('/pi/podcasts', { guids: ['found-guid'] });
  ok(!('found-guid' in stale.body), 'an entry past its TTL is absent rather than served stale');
}

await app.close();
await closePool();

console.log(`\n${checks} checks`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
console.log('ok');
