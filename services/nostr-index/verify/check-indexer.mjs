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
import { Indexer } from '../src/indexer.ts';
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

indexer.stop();
await relay.close();
await closePool();

console.log(`\n${checks} checks`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
console.log('ok');
