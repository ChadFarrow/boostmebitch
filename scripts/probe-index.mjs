// Measure what a feed load actually costs against relays, stage by stage, and
// optionally compare it against the read index.
//
// Usage:
//   npm run probe:index
//   npm run probe:index -- --npub <npub>                  also time a /npub page
//   npm run probe:index -- --index https://host --key K   time the index too
//
// Why this exists: this change is a performance claim, and a performance claim
// with no before number is unfalsifiable. Run it BEFORE deploying the index and
// again after, and put both in the PR.
//
// It re-states the FILTERS rather than importing the app's fetchers, and that
// is a deliberate limit worth knowing. lib/nostr/* is browser-only - it reaches
// localStorage and window - so it cannot load under Node at all. What this
// measures is therefore the relay round trips, which is where the seconds are;
// it is not measuring this app's parsing, which is microseconds.
//
// Read-only. It queries relays and prints. It writes nothing and pays nothing.

import { SimplePool, nip19 } from 'nostr-tools';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// Mirrors DEFAULT_RELAYS / PROFILE_RELAYS in lib/nostr/relays.ts. Keep them in
// step or this stops measuring what a real page waits, which is its whole job.
//
// BASELINE, for comparison across the trim: with `relay.nostr.band` in RELAYS
// and `nostr.bitcoiner.social` + `eden.nostr.land` in PROFILE_RELAYS, this run
// totalled 42037ms on 2026-08-25 with every single stage returning at its
// ceiling (7025 / 7002 / 7002 / 7002 / 7002 / 7003). None of those three served
// an event; they were removed for that. Do not read a later number against this
// one as an index result — it is the relay path getting out of its own way.
const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.fountain.fm',
];
const PROFILE_RELAYS = ['wss://purplepag.es'];

// The app's own ceilings, from lib/nostr/pool.ts. Copied so the numbers below
// are comparable to what a real page waits.
const FEED_QUERY_MAX_WAIT_MS = 8000;
const MAX_THREAD_DEPTH = 6;
const LIMIT = 100;

const pool = new SimplePool();
const ms = (t) => `${(performance.now() - t).toFixed(0)}ms`;

async function timed(label, fn) {
  const t = performance.now();
  const value = await fn();
  const took = performance.now() - t;
  console.log(`  ${label.padEnd(38)} ${took.toFixed(0).padStart(6)}ms`);
  return { value, took };
}

console.log('\n=== RELAY PATH: global feed ===');
const relayStart = performance.now();

const notes = await timed('kind:1 podcast notes', () =>
  pool.querySync(RELAYS, {
    kinds: [1], '#k': ['podcast:guid', 'podcast:item:guid'], limit: LIMIT,
  }, { maxWait: FEED_QUERY_MAX_WAIT_MS }).catch(() => []));

// The reply tree is one query PER DEPTH, serially, and it blocks profile
// resolution from even starting. That serialisation is the single biggest
// cost in a feed load and the clearest thing the index removes.
let frontier = notes.value.map((e) => e.id);
const seenReplies = new Set();
let replyTotal = 0;
for (let depth = 0; depth < MAX_THREAD_DEPTH && frontier.length; depth++) {
  const { value } = await timed(`  reply tree depth ${depth + 1}`, () =>
    pool.querySync(RELAYS, { kinds: [1], '#e': frontier, limit: 500 },
      { maxWait: FEED_QUERY_MAX_WAIT_MS }).catch(() => []));
  const fresh = value.filter((e) => !seenReplies.has(e.id));
  fresh.forEach((e) => seenReplies.add(e.id));
  replyTotal += fresh.length;
  frontier = fresh.map((e) => e.id);
}

const authors = Array.from(new Set([...notes.value, ...seenReplies].map((e) => e.pubkey ?? e)));
const profilePks = Array.from(new Set(notes.value.map((e) => e.pubkey)));
const profiles = await timed('kind:0 profiles (pass 1)', () =>
  pool.querySync([...RELAYS, ...PROFILE_RELAYS], { kinds: [0], authors: profilePks },
    { maxWait: FEED_QUERY_MAX_WAIT_MS }).catch(() => []));

const gotProfiles = new Set(profiles.value.map((e) => e.pubkey));
const missing = profilePks.filter((pk) => !gotProfiles.has(pk));
if (missing.length) {
  await timed(`kind:10002 outbox for ${missing.length} missing`, () =>
    pool.querySync([...RELAYS, ...PROFILE_RELAYS], { kinds: [10002], authors: missing },
      { maxWait: FEED_QUERY_MAX_WAIT_MS }).catch(() => []));
}

const relayTotal = performance.now() - relayStart;
console.log(`  ${'-'.repeat(46)}`);
console.log(`  ${'TOTAL'.padEnd(38)} ${relayTotal.toFixed(0).padStart(6)}ms`);
console.log(`  ${notes.value.length} notes, ${replyTotal} replies, ${profiles.value.length} profiles, ${authors.length} authors`);

// --- how much history is there, i.e. how big does the database get? ---------
console.log('\n=== INDEX SIZE ESTIMATE ===');
const since = Math.floor(Date.now() / 1000) - 30 * 86400;
const t30 = performance.now();
const month = await pool.querySync(RELAYS, {
  kinds: [1], '#k': ['podcast:guid', 'podcast:item:guid'], since, limit: 5000,
}, { maxWait: 20000 }).catch(() => []);
const bytes = month.reduce((n, e) => n + JSON.stringify(e).length, 0);
console.log(`  ${month.length} podcast notes in the last 30 days (${ms(t30)})`);
console.log(`  ~${(bytes / 1024).toFixed(0)} KB raw, so roughly ${((bytes / 1024 / 1024) * 12).toFixed(1)} MB/year before indexes`);
if (month.length >= 5000) console.log('  NOTE: hit the 5000 limit, so this is a FLOOR, not the real count');

// --- an npub page, which is the heaviest surface ----------------------------
const npubArg = flag('--npub');
if (npubArg) {
  console.log(`\n=== RELAY PATH: /npub/${npubArg.slice(0, 12)}... ===`);
  let pk;
  try {
    const d = nip19.decode(npubArg);
    pk = d.type === 'npub' ? d.data : null;
  } catch { /* handled below */ }
  if (!pk) {
    console.log('  not a valid npub, skipping');
  } else {
    const t = performance.now();
    // fetchBoostsSentBy pays this outbox lookup BEFORE its own scan - two
    // multi-second windows back to back, which the code comment measures at
    // 16s versus 8s.
    await timed('kind:10002 author outbox (blocking)', () =>
      pool.querySync([...RELAYS, ...PROFILE_RELAYS], { kinds: [10002], authors: [pk] },
        { maxWait: FEED_QUERY_MAX_WAIT_MS }).catch(() => []));
    await timed('boosts sent (kind:1 by author)', () =>
      pool.querySync(RELAYS, { kinds: [1], authors: [pk], limit: LIMIT },
        { maxWait: FEED_QUERY_MAX_WAIT_MS }).catch(() => []));
    await timed('boosts received (kind:1 #p)', () =>
      pool.querySync(RELAYS, { kinds: [1], '#p': [pk], limit: LIMIT },
        { maxWait: FEED_QUERY_MAX_WAIT_MS }).catch(() => []));
    await timed('zaps received (kind:9735 #p)', () =>
      pool.querySync(RELAYS, { kinds: [9735], '#p': [pk], limit: LIMIT },
        { maxWait: FEED_QUERY_MAX_WAIT_MS }).catch(() => []));
    console.log(`  ${'-'.repeat(46)}`);
    console.log(`  ${'TOTAL'.padEnd(38)} ${(performance.now() - t).toFixed(0).padStart(6)}ms`);
  }
}

// --- the same thing from the index -----------------------------------------
const indexUrl = flag('--index');
const indexKey = flag('--key');
if (indexUrl && indexKey) {
  console.log('\n=== INDEX PATH ===');
  const t = performance.now();
  const res = await fetch(`${indexUrl.replace(/\/$/, '')}/feed/global?limit=${LIMIT}`, {
    headers: { 'x-index-key': indexKey },
  }).catch((e) => ({ ok: false, statusText: e.message }));
  if (!res.ok) {
    console.log(`  request failed: ${res.status ?? ''} ${res.statusText ?? ''}`);
  } else {
    const b = await res.json();
    const took = performance.now() - t;
    console.log(`  ${'one request, whole bundle'.padEnd(38)} ${took.toFixed(0).padStart(6)}ms`);
    console.log(`  ${b.notes.length} notes, ${b.replies.length} replies, ${b.quoted.length} quoted, ${b.profiles.length} profiles`);
    const behind = Math.floor(Date.now() / 1000) - (b.indexedThrough || 0);
    console.log(`  index last saw an event ${behind}s ago`);
    console.log(`\n  relay path ${relayTotal.toFixed(0)}ms -> index path ${took.toFixed(0)}ms  (${(relayTotal / took).toFixed(1)}x)`);
    console.log('  NB: the client also verifies every event, ~3ms each, chunked off the main thread.');
  }
} else {
  console.log('\n(pass --index <url> --key <key> to compare against the read index)');
}

pool.close([...RELAYS, ...PROFILE_RELAYS]);
process.exit(0);
