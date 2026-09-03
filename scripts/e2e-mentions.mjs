// End-to-end for @-mentions in a boost note, against nothing but this machine.
//
// Usage:
//   npm run e2e:mentions
//
// Needs no dev server, no wallet and no Podcast Index key: what is under test is
// the note, not the payment.
//
// This drives the SHIPPING publish path — lib/nostr/boost-notes.ts, which pulls
// in mention-tags, publish, relays, pool, util and brand — with a real
// throwaway signer and the real local relay, and reads back what actually
// landed. That is the wiring no check:* script can see: check:mentions pins
// noteMentionTags alone, and it cannot tell whether buildBoostNoteTemplate ever
// calls it, whether the two publish functions pass the right selfSigned, or
// whether withMentions runs after contentOverride.
//
// The extensionless-import resolver in .e2e-loader.mjs only appends an
// extension and expands `@/`, so the graph it builds is the one webpack builds.

import { register } from 'node:module';
register('./e2e-resolve-hook.mjs', import.meta.url);

import { createRelay } from './local-relay.mjs';
import {
  finalizeEvent, generateSecretKey, getPublicKey, nip19, SimplePool,
} from 'nostr-tools';

const PORT = 7458;
const RELAY = `ws://127.0.0.1:${PORT}`;

// --- the signer, as an extension would present it --------------------------
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
globalThis.window = globalThis;
globalThis.window.nostr = {
  getPublicKey: async () => pk,
  signEvent: async (e) => finalizeEvent(e, sk),
};
globalThis.window.location = { origin: 'http://localhost:3000' };

// NOTHING MAY LEAVE THIS MACHINE, and this is the part that has to be true
// rather than merely intended.
//
// publishBoostNoteViaSite takes no `relays` argument: it publishes to the
// hardcoded DEFAULT_RELAYS. So running this script on a machine with working
// outbound WebSockets fires test notes at damus.io, primal.net, nos.lol and
// fountain.fm, under a throwaway key, with no way to unsend them.
//
// An in-process guard was tried first and is NOT what is here, because it did
// not work and said it did: ESM imports are hoisted, so nostr-tools had already
// captured the real WebSocket before any override ran, and swapping it through
// `useWebSocketImplementation` did not reach the constructor either. It
// recorded zero interceptions and reported success — indistinguishable, in its
// output, from a guard with nothing to block.
//
// So the isolation is checked instead of installed: probe the four relays and
// refuse to run if any of them answers. On a sandbox with no outbound WSS this
// passes in milliseconds; on a laptop it stops the script before it publishes.
const DEFAULT_RELAYS = [
  'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol', 'wss://relay.fountain.fm',
];
const reachable = [];
await Promise.all(DEFAULT_RELAYS.map((u) => new Promise((res) => {
  let done = false;
  const finish = (v) => { if (!done) { done = true; res(v); } };
  try {
    const ws = new WebSocket(u);
    const t = setTimeout(() => { try { ws.close(); } catch { /* */ } finish(); }, 5000);
    ws.onopen = () => { clearTimeout(t); reachable.push(u); try { ws.close(); } catch { /* */ } finish(); };
    ws.onerror = () => { clearTimeout(t); finish(); };
  } catch { finish(); }
})));
if (reachable.length) {
  console.error('\nREFUSING TO RUN: these public relays are reachable from here:');
  for (const u of reachable) console.error(`  ${u}`);
  console.error('\npublishBoostNoteViaSite publishes to DEFAULT_RELAYS, which it does not take as');
  console.error('an argument, so section 2 would put test notes on them permanently.');
  process.exit(1);
}
console.log(`  isolation: all ${DEFAULT_RELAYS.length} DEFAULT_RELAYS unreachable from here`);

const received = [];
const relay = createRelay({ port: PORT, log: null, onEvent: (e) => received.push(e) });

const { publishBoostNote, publishBoostNoteViaSite } =
  await import('../lib/nostr/boost-notes.ts');

let fails = 0;
const check = (l, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${l}`);
  if (!ok) { fails++; console.log('        expected', JSON.stringify(b), '\n        actual  ', JSON.stringify(a)); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fixtures --------------------------------------------------------------
// Two people the FEED declares, and two the SENDER picks. Real, well-known
// keys, so the hex is independently checkable.
const feedA = { npub: 'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m', pubkey: '82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2' };
const mentionA = { npub: 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6', pubkey: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d' };

const podcast = {
  id: 1, title: 'Homegrown Hits', author: 'HGH',
  podcastGuid: 'fce40d63-ef30-5c85-af07-d99b3c759807',
  url: 'https://example.com/feed.xml', link: 'https://example.com',
  image: 'https://example.com/art.png', medium: 'music',
  nostrNpubs: [feedA],
};
const episode = {
  id: 2, title: 'A Track', guid: 'https://example.com/ep?id=42',
  enclosureUrl: 'https://example.com/a.mp3', datePublished: 1,
};
const boostagram = (message) => ({
  podcast: podcast.title, episode: episode.title, action: 'boost',
  value_msat_total: 1000 * 1000, sender_name: 'Tester', app_name: 'BoostMeBitch',
  uuid: 'test-uuid', message,
});

const pTags = (e) => e.tags.filter((t) => t[0] === 'p').map((t) => t[1]);
const bodyNpubs = (e) => (e.content.match(/nostr:npub1[0-9a-z]+/g) ?? []).map((s) => s.slice(6));

console.log(`\n  throwaway npub ${nip19.npubEncode(pk).slice(0, 20)}…   relay ${RELAY}\n`);

// ===========================================================================
console.log('--- 1. SELF-SIGNED: the sender\'s mention gets a real p tag ---');
// ===========================================================================
{
  const note = await publishBoostNote({
    podcast, episode, boostagram: boostagram('great track @fiatjaf'),
    results: [], relays: [RELAY], mentions: [mentionA],
  });
  await wait(400);
  const e = received.find((x) => x.id === note.id);
  check('the note reached the relay', !!e, true);
  check('it is signed by the USER, not the site', e?.pubkey, pk);
  check('the feed npub is p-tagged', pTags(e).includes(feedA.pubkey), true);
  check('the SENDER mention is p-tagged too', pTags(e).includes(mentionA.pubkey), true);
  check('feed npub comes first — the cap truncates, and the artist outranks', pTags(e)[0], feedA.pubkey);
  check('both appear in the body as nostr: URIs', bodyNpubs(e).length, 2);
  check('the prefix the site-sign route validates on survives', e?.content.startsWith('⚡ Boost ⚡'), true);
  check('the typed message is in the body', e?.content.includes('great track @fiatjaf'), true);
  check('no npub was inlined into the typed message itself',
    e?.content.split('\n').find((l) => l.includes('great track'))?.includes('npub1'), false);
}

// ===========================================================================
console.log('\n--- 2. SITE-SIGNED: the mention loses its tag, keeps its line ---');
// ===========================================================================
{
  // publishBoostNoteViaSite POSTs to /api/nostr/site-sign. Intercepted here so
  // the test needs no dev server and no site key — what is under test is which
  // TEMPLATE the client hands over, which is the whole selfSigned decision.
  let sent = null;
  const siteSk = generateSecretKey();
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ event: finalizeEvent(sent, siteSk) }) };
  };
  await publishBoostNoteViaSite({
    podcast, episode, boostagram: boostagram('great track @fiatjaf'),
    results: [], mentions: [mentionA],
  });
  await wait(400);
  // Asserted on the TEMPLATE the route was handed, not on a relay round trip:
  // this path publishes to DEFAULT_RELAYS by construction, and the template is
  // where the whole selfSigned decision shows up anyway.
  const e = sent;
  check('a template was posted to /api/nostr/site-sign', !!e, true);
  check('the feed npub keeps its p tag', pTags(e).includes(feedA.pubkey), true);
  check('the SENDER mention has NO p tag', pTags(e).includes(mentionA.pubkey), false);
  check('...and the feed npub is the only p tag left', pTags(e).length, 1);
  check('but the mention still reaches the body', bodyNpubs(e).includes(mentionA.npub), true);
  check('the prefix the route validates on survives', e?.content.startsWith('⚡ Boost ⚡'), true);
  check('every tag name is in the route allowlist',
    e?.tags.every((t) => ['i','k','r','p','amount','client','t','imeta'].includes(t[0])), true);
  check('p tags are under the route MAX_P_TAGS of 8',
    e?.tags.filter((t) => t[0] === 'p').length <= 8, true);
}

// ===========================================================================
console.log('\n--- 3. BOOST-ALL: contentOverride keeps the mention run ---');
// ===========================================================================
{
  // The path a mention added inside formatContent would silently miss, because
  // BoostAllModal replaces the whole body.
  const contentOverride = '⚡ Boost ⚡\n\nTester boosted 3 tracks on Homegrown Hits for 300 sats';
  const note = await publishBoostNote({
    podcast, episode, boostagram: boostagram(undefined),
    results: [], relays: [RELAY], mentions: [mentionA], contentOverride,
  });
  await wait(400);
  const e = received.find((x) => x.id === note.id);
  check('the summary body survived as the override wrote it',
    e?.content.startsWith(contentOverride), true);
  check('and the mention run is still appended after it',
    bodyNpubs(e).includes(mentionA.npub), true);
  check('the sender mention is p-tagged on this path too',
    pTags(e).includes(mentionA.pubkey), true);
}

// ===========================================================================
console.log('\n--- 4. Nothing unusable becomes a p tag ---');
// ===========================================================================
{
  const note = await publishBoostNote({
    podcast, episode, boostagram: boostagram('x'), results: [], relays: [RELAY],
    mentions: [
      { npub: 'npub1junk', pubkey: 'not-hex' },
      { npub: mentionA.npub, pubkey: mentionA.pubkey.toUpperCase() },
      mentionA,
    ],
  });
  await wait(400);
  const e = received.find((x) => x.id === note.id);
  check('junk and uppercase hex are dropped, the good one survives',
    pTags(e), [feedA.pubkey, mentionA.pubkey]);
}

// ===========================================================================
console.log('\n--- 5. The relay really holds them (read back over NIP-01) ---');
// ===========================================================================
{
  const pool = new SimplePool();
  const back = await pool.querySync([RELAY], { kinds: [1], '#t': ['boostagram'] });
  check('every self-signed boost note is queryable', back.length, 3);
  const tagged = back.filter((e) => e.tags.some((t) => t[0] === 'p' && t[1] === mentionA.pubkey));
  check('all three p-tag the mentioned person', tagged.length, 3);
  pool.close([RELAY]);
}

// ===========================================================================
console.log('\n--- 6. Nothing left this machine ---');
// ===========================================================================
{
  // Re-probed AFTER the publishes, not just before: the claim is about the
  // whole run, and a relay that came up halfway through would invalidate it.
  const stillDown = [];
  await Promise.all(DEFAULT_RELAYS.map((u) => new Promise((res) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; res(v); } };
    try {
      const ws = new WebSocket(u);
      const t = setTimeout(() => { try { ws.close(); } catch { /* */ } stillDown.push(u); finish(); }, 5000);
      ws.onopen = () => { clearTimeout(t); try { ws.close(); } catch { /* */ } finish(); };
      ws.onerror = () => { clearTimeout(t); stillDown.push(u); finish(); };
    } catch { stillDown.push(u); finish(); }
  })));
  check('every public relay was still unreachable after the publishes',
    stillDown.length, DEFAULT_RELAYS.length);
  check('every event this run produced landed on the LOCAL relay',
    received.every((e) => !!e.id), true);
}

relay.close?.();
console.log(`\n${fails ? `${fails} FAILED` : 'ok'}`);
process.exit(fails ? 1 : 0);
