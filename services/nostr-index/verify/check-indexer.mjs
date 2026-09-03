// Exercises the indexer against a scripted local relay: does a live
// subscription actually land an event in Postgres, does backfill page, does a
// kind:5 arriving later tombstone a note already stored, and does a forbidden
// kind pushed by a hostile relay stay OUT even though no filter asked for it.
//
// That last one is the reason ingest re-checks the kind rather than trusting
// the subscription filter. A filter is a REQUEST. A relay can send anything.

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { getPool, closePool } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import { Indexer, fingerprintOf } from '../src/indexer.ts';
import { startMockRelay } from './mock-relay.mjs';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }

let failures = 0, checks = 0;
const ok = (cond, what) => { checks++; if (!cond) { failures++; console.error(`FAIL ${what}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return ok(true, what);
    await sleep(100);
  }
  return ok(false, `${what} (timed out after ${timeoutMs}ms)`);
}

const db = getPool(DATABASE_URL);
await migrate(DATABASE_URL);
await db.query('truncate events, event_tags, profiles, tracked_pubkeys, pi_queue, pi_podcasts, pi_episodes, indexer_state cascade');

const SK = generateSecretKey();
const PK = getPublicKey(SK);
const FEED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NOW = Math.floor(Date.now() / 1000);
const sign = (tpl, sk = SK) => finalizeEvent({ created_at: NOW, content: '', tags: [], ...tpl }, sk);

// Three pages worth of history, so backfill has to actually page.
const history = [];
for (let i = 0; i < 5; i++) {
  history.push(sign({
    kind: 1, created_at: NOW - 1000 - i * 60, content: `historic boost ${i}`,
    tags: [['k', 'podcast:guid'], ['i', `podcast:guid:${FEED}`]],
  }));
}

const relay = await startMockRelay(history);
const cfg = {
  relays: [relay.url()],
  profileRelays: [],
  backfillDays: 365,
  piKey: '', piSecret: '', appName: 'test',
  piTtlHours: 168,
  // Drive the rebuild in milliseconds. In production this is 60s; a check that
  // waited that out would be a check nobody runs.
  resubscribeIntervalMs: 300,
  connectivityCheckMs: 300,
};

const indexer = new Indexer(db, cfg);
await indexer.start();

const count = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);

// --- backfill ---------------------------------------------------------------
await waitFor(
  async () => (await count('select count(*)::int as n from events where kind = 1')) === history.length,
  `backfill paged in all ${history.length} historic notes`,
);
await waitFor(
  async () => (await db.query(`select backfill_done from indexer_state where key = 'backfill:podcast-notes'`)).rows[0]?.backfill_done === true,
  'backfill recorded itself complete so a restart resumes instead of re-walking',
);

// --- live subscription ------------------------------------------------------
const live = sign({
  kind: 1, created_at: NOW, content: 'live boost',
  tags: [['k', 'podcast:guid'], ['i', `podcast:guid:${FEED}`], ['p', 'ab'.repeat(32)]],
});
relay.push(live);
await waitFor(
  async () => (await count('select count(*)::int as n from events where id = $1', [live.id])) === 1,
  'a live subscription delivered a pushed event into Postgres',
);
await waitFor(
  async () => (await count('select count(*)::int as n from pi_queue')) > 0,
  'the podcast identifier on that note was queued for Podcast Index warm-fill',
);
ok(
  (await count('select count(*)::int as n from tracked_pubkeys where pubkey = $1', ['ab'.repeat(32)])) === 1,
  'the p-tagged pubkey is tracked, so its zaps can be indexed later',
);

// --- replies -----------------------------------------------------------------
//
// A reply is a kind:1 with an `e` tag to its parent and NOTHING else naming it
// — no `k: podcast:guid`, no `t: boostagram`. It matches neither core filter,
// and the tracked filter asks its authors for kinds 0/6/5 rather than 1. So the
// only filter shape that finds one is `#e` on the parent id, and without a
// subscription of that shape the index served `replies: []` forever while
// `replyForest`'s recursive CTE ran correctly over an empty set. Measured on
// production 2026-08-25: 50 notes, 0 replies.
//
// The reply watcher rebuilds on `resubscribeIntervalMs`, so wait for it to pick
// the parent up rather than racing it.
const replier = generateSecretKey();
const reply = finalizeEvent({
  kind: 1, created_at: NOW + 5, content: 'replying to that boost', tags: [['e', live.id]],
}, replier);
await waitFor(async () => {
  relay.push(reply);
  return (await count('select count(*)::int as n from events where id = $1', [reply.id])) === 1;
}, 'a reply carrying only an `e` tag was subscribed and stored', 12_000);

// The bundle is what the app actually reads, so assert through it rather than
// through the events table: a stored reply that the query cannot reach is the
// same nothing as a reply never stored.
const { bundle: bundleFor, globalNotes: globalFor } = await import('../src/queries.ts');
const bundled = await bundleFor(db, await globalFor(db, 50), 0);
ok(bundled.replies.some((r) => r.id === reply.id),
   'and /feed/global carries it in `replies`, which is what the client reads');

// --- a relay sending what nobody asked for ---------------------------------
//
// No filter here requests kind:10333 or kind:3. The relay sends them anyway.
const favorites = sign({ kind: 10333, tags: [['i', `podcast:guid:${FEED}`]] });
const follows = sign({ kind: 3, tags: [['p', PK]] });
relay.pushUnsolicited(favorites);
relay.pushUnsolicited(follows);
await sleep(1200);
ok((await count('select count(*)::int as n from events where kind = 10333')) === 0,
   'kind:10333 favorites pushed by a relay are REFUSED - a filter is a request, not a guarantee');
ok((await count('select count(*)::int as n from events where kind = 3')) === 0,
   'kind:3 follows pushed by a relay are REFUSED');

// --- forged event -----------------------------------------------------------
// nostr-tools verifies on its own before handing an event to `onevent`, so
// this proves the pipeline end to end rather than our own check specifically -
// verify/check-ingest.mjs pins `classify` directly for that.
const forged = JSON.parse(JSON.stringify({ ...live, id: 'ff'.repeat(32), content: 'Boosted 1000000 sats' }));
relay.pushUnsolicited(forged);
await sleep(1200);
ok((await count('select count(*)::int as n from events where id = $1', ['ff'.repeat(32)])) === 0,
   'a forged event from the relay never reaches the database');

// --- deletion arriving after the note ---------------------------------------
const tombstone = sign({ kind: 5, created_at: NOW + 10, tags: [['e', live.id]] });
relay.push(tombstone);
await waitFor(
  async () => (await count('select count(*)::int as n from events where id = $1 and deleted_at is not null', [live.id])) === 1,
  'a kind:5 arriving later tombstones a note already stored',
);

// --- a deletion naming someone else own note --------------------------------
const stranger = generateSecretKey();
const target = history[0];
const hostileDeletion = finalizeEvent({ kind: 5, created_at: NOW + 20, content: '', tags: [['e', target.id]] }, stranger);
relay.push(hostileDeletion);
await sleep(1200);
ok((await count('select count(*)::int as n from events where id = $1 and deleted_at is null', [target.id])) === 1,
   'a kind:5 from a DIFFERENT author cannot delete this author note');

// --- the socket drops, and ingestion has to come back -----------------------
//
// This is the one that matters, and it is why this file drives a real relay
// rather than pinning a predicate. The deployed indexer stalled for hours with
// no error anywhere: nostr-tools 2.19.4 defaults `enableReconnect` to false, so
// a dropped socket closed every subscription on that relay and deleted the
// relay from the pool. Core subscriptions are created once in `start()`;
// `subscribeTracked` returns early unless the tracked set changed, which needs
// events, which needs the sockets. Nothing in the process could break that
// loop, and `/health` said `{ok:true}` throughout.
//
// So: prove a reconnect happens, and prove ingestion RESUMES through it. The
// second half is the real assertion — a relay can be reconnected while its
// subscriptions are not re-fired, which looks healthy and indexes nothing.
ok(relay.connections() > 0, 'the indexer holds a connection before the drop');
const droppedFrom = relay.connections();
ok(relay.dropConnections() === droppedFrom, 'every client socket was terminated');
ok(relay.connections() === 0, 'the relay sees no client immediately after the drop');

await waitFor(
  async () => relay.connections() > 0,
  'the indexer reconnected on its own after the socket dropped',
  20_000, // nostr-tools backs off 10s before its first retry
);
ok(indexer.connectedRelays().connected.length === 1,
   'and the pool reports the relay connected, which is what /health reads');

const afterDrop = sign({
  kind: 1, created_at: NOW + 30, content: 'boost published after the socket dropped',
  tags: [['k', 'podcast:guid'], ['i', `podcast:guid:${FEED}`]],
});
relay.push(afterDrop);
await waitFor(
  async () => (await count('select count(*)::int as n from events where id = $1', [afterDrop.id])) === 1,
  'INGESTION RESUMED: an event pushed after the drop reached Postgres',
  20_000,
);

// /health has to be able to tell the difference. A static {ok:true} could not,
// and that is why the stall went unnoticed.
const h = await indexer.health();
ok(h.relaysConnected === 1 && h.relaysConfigured === 1, 'health reports relay connectivity');
ok(h.relaysDown.length === 0, 'health names no relay as down while one is connected');
ok(h.relaysWithoutSubscriptions.length === 0,
   'health reports no connected-but-unsubscribed relay, the state that stalled the service');
ok(typeof h.indexedThrough === 'number' && h.indexedThrough > 0, 'health reports indexedThrough');
ok(h.subscriptions > 0, 'health reports live subscriptions');

indexer.stop();
await relay.close();
await closePool();

// ---------------------------------------------------------------------------
// fingerprintOf — the tracked-set comparison that decides whether to rebuild
// ---------------------------------------------------------------------------
//
// This is the #301 leak. `trackedPubkeys` reads `order by seen_at desc`, so the
// ORDER churns every time an already-tracked pubkey posts while the membership
// barely moves. A digest that folded the list sequentially therefore differed on
// every 60-second tick, and the indexer tore down all 30 tracked subscriptions
// across every relay to rebuild the identical ones — 33 times in 39 minutes,
// about 4.6 MB of REQ payload each, into relays that were not draining it.
//
// Both halves are asserted, because either one alone is a bug: order-blind and
// it never rebuilds when it should; order-sensitive and it rebuilds when it
// should not.
{
  const set = Array.from({ length: 500 }, (_, i) => i.toString(16).padStart(64, '0'));

  ok(fingerprintOf(set) === fingerprintOf([...set]),
     'the same list gives the same fingerprint');

  // Exactly what `order by seen_at desc` does when one tracked pubkey posts
  // again: it moves to the front. Same members, same count, no rebuild wanted.
  const moved = [set[321], ...set.filter((_, i) => i !== 321)];
  ok(fingerprintOf(set) === fingerprintOf(moved),
     'moving one pubkey to the front does NOT change the fingerprint');

  ok(fingerprintOf(set) === fingerprintOf([...set].reverse()),
     'a fully reversed list does NOT change the fingerprint');

  // The case the digest exists for, and the reason it is not a length check:
  // one in, one out, count unchanged, membership different.
  const swapped = [...set.slice(1), 'f'.repeat(64)];
  ok(fingerprintOf(set) !== fingerprintOf(swapped),
     'one pubkey in and one out DOES change it, though the count is identical');

  ok(fingerprintOf(set) !== fingerprintOf(set.slice(0, -1)),
     'a shorter list changes it');

  // XOR alone lets a pair of equal hashes cancel; the sum is carried so a swap
  // that preserves the XOR still has to preserve the sum.
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  ok(fingerprintOf([a, a, b]) !== fingerprintOf([b, b, b]),
     'duplicate hashes do not cancel out of the digest');
}

console.log(`\n${checks} checks`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
console.log('ok');
