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
// The extensionless-import resolver in e2e-resolve-hook.mjs only appends an
// extension and expands `@/`, so the graph it builds is the one webpack builds.

import { register } from 'node:module';
import { readFileSync } from 'node:fs';
register('./e2e-resolve-hook.mjs', import.meta.url);

import { createRelay } from './local-relay.mjs';
import { checker, exit, wait } from './cdp.mjs';
import {
  finalizeEvent, generateSecretKey, getPublicKey, nip19, SimplePool,
} from 'nostr-tools';

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
//
// THE REFUSAL IS SCOPED TO SECTION 2, and widening it back to the whole script
// is a false economy. Section 2 is the only one that publishes to
// DEFAULT_RELAYS; every other section passes `relays: [RELAY]` explicitly and
// cannot reach anything but the local relay. Refusing the entire run meant that
// on any machine with internet — which is every developer laptop — NOTHING here
// was checked, including the wiring assertions that are the whole point of the
// file. A guard that turns the suite off is not protecting the suite.
//
// So: skip the one unsafe section, say so loudly, and make the exit code honest
// about having run a subset.
const ISOLATED = reachable.length === 0;
let skipped = 0;
if (ISOLATED) {
  console.log(`  isolation: all ${DEFAULT_RELAYS.length} DEFAULT_RELAYS unreachable from here`);
} else {
  console.log('  isolation: NOT isolated — these public relays answered:');
  for (const u of reachable) console.log(`    ${u}`);
  console.log('  section 2 (site-signed) will be SKIPPED: publishBoostNoteViaSite takes no');
  console.log('  `relays` argument and would put test notes on them permanently.');
}

const received = [];
const relay = createRelay({ port: 0, log: null, onEvent: (e) => received.push(e) });
// Port 0 and read back, never a fixed port: another run can already hold one.
const RELAY = `ws://127.0.0.1:${await relay.ready}`;

const { publishBoostNote, publishBoostNoteViaSite, siteLandingUrl } =
  await import('../lib/nostr/boost-notes.ts');
const { boostAllLines } = await import('../lib/util.ts');
const { publishReply } = await import('../lib/nostr/interactions.ts');
const { publishLiveChat, streamChatAddr } = await import('../lib/nostr/live-chat.ts');
const { BRAND } = await import('../lib/brand.ts');

const t = checker();
const check = (l, a, b) => t.equal(l, a, b);

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
if (!ISOLATED) {
  skipped += 1;
  console.log('\n--- 2. SITE-SIGNED: SKIPPED (not isolated) ---');
} else {
  // ===========================================================================
  {
    // publishBoostNoteViaSite asks /api/nostr/site-stamp for the note stamp,
    // pays it, then POSTs { template, stamp } to /api/nostr/site-sign. Both are
    // intercepted here so the test needs no server, no site key and no wallet —
    // what is under test is which TEMPLATE the client hands over, which is the
    // whole selfSigned decision.
    let sent = null;
    let firstUrl = null;
    const siteSk = generateSecretKey();
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      firstUrl ??= String(url);
      if (String(url).endsWith('/api/nostr/site-stamp')) {
        sent = body.template;
        return { ok: true, status: 200, json: async () => ({ invoice: 'lnbc10n1e2e', stamp: 'e2e.stamp' }) };
      }
      return { ok: true, status: 200, json: async () => ({ event: finalizeEvent({ ...body.template }, siteSk) }) };
    };
    await publishBoostNoteViaSite({
      podcast, episode, boostagram: boostagram('great track @fiatjaf'),
      results: [], mentions: [mentionA],
    }, { payStamp: async () => {}, state: {} });
    await wait(400);
    // Asserted on the TEMPLATE the route was handed, not on a relay round trip:
    // this path publishes to DEFAULT_RELAYS by construction, and the template is
    // where the whole selfSigned decision shows up anyway.
    const e = sent;
    check('a template was posted to /api/nostr/site-stamp', !!e, true);
    check('the site path asked for a stamp first', firstUrl?.endsWith('/api/nostr/site-stamp'), true);
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
}

// ===========================================================================
console.log('\n--- 3. BOOST-ALL: contentOverride keeps the mention run ---');
// ===========================================================================
{
  // The path a mention added inside formatContent would silently miss, because
  // BoostAllModal replaces the whole body.
  const contentOverride = '⚡ Boost ⚡\n\nTester boosted 300 sats to 3 tracks from Homegrown Hits via BoostMeBitch';
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
console.log('\n--- 4b. A REPLY carries the sender\'s mentions too ---');
// ===========================================================================
// THE SECOND SURFACE, and the reason it is here rather than in check:mentions:
// that script pins `noteMentionTags` alone and cannot tell whether
// `publishReply` ever calls it, nor what `selfSigned` it passes. A reply has no
// site-signed path — `signAndPublish` reads `activeNostr()` and throws without a
// signer — so the answer is a hardcoded `true`, and this is what holds that
// claim to the wire.
{
  // Someone else's note to reply to, with a podcast tag so the inheritance is
  // observable, and authored by the person we ALSO mention — which is the
  // dedupe case: they must end up with exactly one `p` tag, not two.
  const otherSk = generateSecretKey();
  const parent = finalizeEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000) - 60,
    tags: [['i', `podcast:guid:${podcast.podcastGuid}`], ['k', 'podcast:guid']],
    content: 'the parent note',
  }, otherSk);

  // Three mentions covering the two placements `inlineMentions` distinguishes:
  // NAMED ones are substituted where the sender typed them; a nameless one — a
  // pasted npub, which has no profile yet — cannot be matched to any text and
  // falls through to the trailing run instead. Dropping that second half gave
  // those people a `p` tag and no trace in the body, which is what this caught.
  const namedMention = { ...mentionA, name: 'fiatjaf' };
  const parentAsMention = {
    npub: nip19.npubEncode(getPublicKey(otherSk)), pubkey: getPublicKey(otherSk), name: 'self',
  };
  const namelessMention = { npub: feedA.npub, pubkey: feedA.pubkey };
  const note = await publishReply({
    parent,
    content: 'agreed @fiatjaf — and @self too',
    relays: [RELAY],
    mentions: [namedMention, parentAsMention, namelessMention],
  });
  await wait(400);
  const e = received.find((x) => x.id === note.id);
  check('the reply reached the relay', !!e, true);
  check('it is signed by the USER', e?.pubkey, pk);
  check('it marks the parent as a NIP-10 reply',
    e?.tags.some((t) => t[0] === 'e' && t[1] === parent.id && t[3] === 'reply'), true);
  check('the parent author is p-tagged', pTags(e).includes(parent.pubkey), true);
  // THE WIRING ASSERTION: publishReply actually reaches noteMentionTags.
  check('the sender mention is p-tagged', pTags(e).includes(mentionA.pubkey), true);
  check('...substituted where the sender typed it',
    bodyNpubs(e).includes(mentionA.npub), true);
  check('...with the typed @name consumed, not left beside the URI',
    e?.content.includes('@fiatjaf'), false);
  check('a NAMELESS mention still reaches the body, via the trailing run',
    bodyNpubs(e).includes(feedA.npub), true);
  check('...and is p-tagged like the rest', pTags(e).includes(feedA.pubkey), true);
  // THE DEDUPE: mentioning the person you are replying to must not tag twice.
  check('the parent author is tagged exactly once',
    pTags(e).filter((x) => x === parent.pubkey).length, 1);
  check('the podcast tags are still inherited',
    e?.tags.some((t) => t[0] === 'i' && t[1] === `podcast:guid:${podcast.podcastGuid}`), true);
  // NIP-89 attribution, the same tag a boost note carries and the one
  // `discover.ts` reads back to print "via …". Asserted on the wire because it
  // is per-BRAND: a hard-coded name here would be the other deploy's word under
  // a reply on the family-friendly site.
  const clientTag = e?.tags.find((t) => t[0] === 'client');
  check('the reply is attributed to this client', !!clientTag, true);
  check('...by the brand wire name, not a literal', clientTag?.[1], BRAND.wireName);
}

// ===========================================================================
console.log('\n--- 4c. A LIVE CHAT message carries the sender\'s mentions too ---');
// ===========================================================================
// THE THIRD SURFACE. A kind:1311 is the one place a mention can look completely
// correct and still reach nobody: every client renders a `nostr:npub…` in the
// body as @name, so the sender sees the feature work while the person they
// named is never notified. The `p` tag is the only half that notifies, and it
// is invisible from the screen — which is why it is asserted here on the wire.
//
// `selfSigned` is hardcoded `true` in publishLiveChat, and this holds that
// claim: the event must be signed by the USER's key, and the sender's picks
// must survive as tags. There is no site-signed path for kind:1311 today.
{
  const streamId = `${pk}:e2e-mentions-stream`;
  const namedMention = { ...mentionA, name: 'fiatjaf' };
  // A pasted npub, with no profile and so no name to match in the text. It
  // cannot be inlined and must fall through to the trailing run.
  const namelessMention = { npub: feedA.npub, pubkey: feedA.pubkey };
  const note = await publishLiveChat(
    streamId,
    'nice set @fiatjaf',
    [namedMention, namelessMention],
    [RELAY],
  );
  await wait(400);
  const e = received.find((x) => x.id === note.id);
  check('the chat message reached the relay', !!e, true);
  check('it is a kind:1311', e?.kind, 1311);
  check('it is signed by the USER', e?.pubkey, pk);
  // The NIP-53 address, still first, still marked root — that tag is how every
  // other client in the room finds the message at all.
  const aTag = e?.tags[0];
  check('the `a` root tag is still the FIRST tag', aTag?.[0], 'a');
  check('...addressing the stream', aTag?.[1], streamChatAddr(streamId));
  check('...still marked root', aTag?.[3], 'root');
  // THE WIRING ASSERTION: publishLiveChat actually reaches mentionParts.
  check('the sender mention is p-tagged', pTags(e).includes(mentionA.pubkey), true);
  check('...substituted where the sender typed it',
    bodyNpubs(e).includes(mentionA.npub), true);
  check('...with the typed @name consumed, not left beside the URI',
    e?.content.includes('@fiatjaf'), false);
  check('a NAMELESS mention still reaches the body, via the trailing run',
    bodyNpubs(e).includes(feedA.npub), true);
  check('...and is p-tagged like the rest', pTags(e).includes(feedA.pubkey), true);
  // NIP-89 attribution, the same tag the reply above carries. Asserted on the
  // wire and against BRAND.wireName because it is per-BRAND: a literal here
  // would be the other deploy's word under a message in the room, in a signed
  // event nobody can edit.
  const chatClient = e?.tags.find((t) => t[0] === 'client');
  check('the chat message is attributed to this client', !!chatClient, true);
  check('...by the brand wire name, not a literal', chatClient?.[1], BRAND.wireName);
}

// ===========================================================================
console.log('\n--- 5. The relay really holds them (read back over NIP-01) ---');
// ===========================================================================
{
  const pool = new SimplePool();
  // Filtered on `#t: boostagram`, so the reply above is deliberately not in
  // this count — it is a kind:1 without that tag, which is what a reply is.
  const back = await pool.querySync([RELAY], { kinds: [1], '#t': ['boostagram'] });
  check('every self-signed boost note is queryable', back.length, 3);
  const tagged = back.filter((e) => e.tags.some((t) => t[0] === 'p' && t[1] === mentionA.pubkey));
  check('all three p-tag the mentioned person', tagged.length, 3);
  pool.close([RELAY]);
}

// ===========================================================================
console.log('\n--- 5b. A boost that paid a TRACK names it, in the body and the tags ---');
// ===========================================================================
// Wiring, not arithmetic: check:vts pins boostNoteTrack, and cannot see where
// the builder puts its answer, whether the site path still passes the route's
// caps with it, or whether a note WITHOUT a paid track is left exactly as it
// was. After section 5 on purpose, so that section's count is unchanged.
{
  const track = {
    split: {
      title: 'Copenhagen Time', artist: 'Matt Finlay',
      remoteItem: {
        feedGuid: 'e88a4a67-877c-5e03-b8fd-a70cebc821af',
        itemGuid: '9f515f93-eda1-4146-8637-7def160879b5',
      },
    },
    results: [{ ok: true, sats: 340 }],
  };
  const iTags = (e) => e.tags.filter((t) => t[0] === 'i').map((t) => t[1]);
  const kTags = (e) => e.tags.filter((t) => t[0] === 'k').map((t) => t[1]);

  const note = await publishBoostNote({
    podcast, episode, boostagram: boostagram('what a song'), results: [], relays: [RELAY], track,
  });
  await wait(400);
  const e = received.find((x) => x.id === note.id);
  check('the track note reached the relay', !!e, true);
  const lines = e?.content.split('\n') ?? [];
  check('one sentence: the song, its artist, the episode of the show',
    lines.includes(`Tester boosted 1000 sats to Copenhagen Time by Matt Finlay from ${episode.title} of ${podcast.title} via BoostMeBitch`), true);
  check('no 📻 or 🎵 line is left', /📻|🎵|→/.test(e?.content ?? '📻'), false);
  check('the show and episode pairs stay FIRST, unchanged', e?.tags.slice(0, 4).map((t) => t[0] + ' ' + t[1]), [
    `i podcast:guid:${podcast.podcastGuid}`, 'k podcast:guid',
    `i podcast:item:guid:${episode.guid}`, 'k podcast:item:guid',
  ]);
  check('then the track\'s feed and item', iTags(e).slice(2), [
    'podcast:guid:e88a4a67-877c-5e03-b8fd-a70cebc821af',
    'podcast:item:guid:9f515f93-eda1-4146-8637-7def160879b5',
  ]);
  check('...directly after the episode pair', e?.tags[4]?.[1], 'podcast:guid:e88a4a67-877c-5e03-b8fd-a70cebc821af');
  check('no extra k tag — both kinds are already declared', kTags(e), ['podcast:guid', 'podcast:item:guid']);
  check('the track tags carry a restorable hint on this site',
    e?.tags[5]?.[2], `${BRAND.origin}/?podcast=e88a4a67-877c-5e03-b8fd-a70cebc821af&episode=9f515f93-eda1-4146-8637-7def160879b5`);

  // A track leg that did NOT settle must leave the note byte-for-byte as a
  // boost with no track at all — the only way to prove "unchanged" without
  // pinning a per-brand banner URL here.
  const capture = async (args) => {
    let sent = null;
    const realFetch = globalThis.fetch;
    // A 599 from the stamp route makes the ladder post from a one-time key. This
    // section runs only isolated, so that publish reaches nobody.
    globalThis.fetch = async (_u, init) => {
      sent ??= JSON.parse(init.body).template;
      return { ok: false, status: 599, json: async () => ({}) };
    };
    await publishBoostNoteViaSite(args, { payStamp: async () => {}, state: {} }).catch(() => {});
    globalThis.fetch = realFetch;
    if (sent) delete sent.created_at;
    return sent;
  };
  const base = { podcast, episode, boostagram: boostagram('x'), results: [] };
  const plain = await capture(base);
  const unpaid = await capture({ ...base, track: { ...track, results: [{ ok: false, sats: 340 }] } });
  check('an UNPAID track leg leaves the note identical to no track at all',
    JSON.stringify(unpaid), JSON.stringify(plain));
  const paid = await capture({ ...base, track });
  check('the site path names the song too', paid?.content.includes('to Copenhagen Time by Matt Finlay from'), true);
  check('...and the prefix the route validates on', paid?.content.startsWith('⚡ Boost ⚡'), true);

  // The route's caps, in the worst case this builder can meet: the most p
  // tags it can emit, a long URL episode guid, and 200-character track guids
  // (the longest boostNoteTrack keeps). Mirrors app/api/nostr/site-sign.
  const many = Array.from({ length: 8 }, (_, i) => {
    const sk = generateSecretKey();
    return { npub: nip19.npubEncode(getPublicKey(sk)), pubkey: getPublicKey(sk), name: `m${i}` };
  });
  const longEp = { ...episode, guid: `https://example.com/${'e'.repeat(220)}`, title: 'T'.repeat(150), link: `https://example.com/${'l'.repeat(300)}` };
  const worst = await capture({
    podcast: { ...podcast, nostrNpubs: many.slice(0, 4) }, episode: longEp,
    boostagram: boostagram('m'.repeat(280)), results: [], mentions: many,
    track: { split: { title: 'S'.repeat(300), artist: 'A'.repeat(300),
      remoteItem: { feedGuid: 'f'.repeat(200), itemGuid: 'g'.repeat(200) } }, results: [{ ok: true, sats: 1 }] },
  });
  const total = worst.tags.reduce((n, t) => n + t.reduce((m, x) => m + x.length, 0), 0);
  check('worst case: tag total within MAX_TAGS_TOTAL_LEN 4096', total <= 4096, true);
  check('worst case: every tag item within 512', worst.tags.every((t) => t.every((x) => x.length <= 512)), true);
  check('worst case: at most 40 tags', worst.tags.length <= 40, true);
  check('worst case: every tag name is in the route allowlist',
    worst.tags.every((t) => ['i','k','r','p','amount','client','t','imeta','q'].includes(t[0])), true);
  // The site-sign route refuses a body over its limit — it is unauthenticated,
  // so the limit bounds how much free text a stranger can have the site sign.
  // A REAL boost must never meet it (Chad, 2026-11-17): the limit sits just
  // above the largest real note, and past every real maximum the body gives
  // way part by part, never the note. Read from BOTH sources, which must agree:
  // the route cannot load here (next/server), and a copy would pass green
  // while the shipping numbers drift apart.
  const constIn = (file, name) => Number((readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    .match(new RegExp(`const ${name} = (\\d+);`)) ?? [])[1]);
  const LIMIT = constIn('lib/site-sign-template.ts', 'MAX_CONTENT');
  check('the builder\'s limit is the route\'s', constIn('lib/nostr/boost-notes.ts', 'SITE_SIGN_MAX_CONTENT'), LIMIT);
  check('worst case: body within the limit', worst.content.length <= LIMIT, true);
  check('...while the track tags still ride', worst.tags.filter((t) => t[0] === 'i').length, 4);

  const fill = (n, tag) => { const h = `https://example.com/${tag}/`; return h + 'x'.repeat(n - h.length); };
  // The receipt's hints are relays the user writes to, and a real one can be
  // long: filter.nostr.wine puts the npub and a query in the URL. Three of
  // those, the most the nevent carries.
  const relayHints = many.slice(0, 3).map((m) => `wss://filter.nostr.wine/${m.npub}?broadcast=true`);
  const RECEIPT = { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), relays: relayHints };
  // This site's own link carries the episode guid: sized so the link is 512.
  const siteBase = siteLandingUrl(podcast.podcastGuid, 'g').length - 1;
  // Every part at the most a real boost carries: a 250-character message (the
  // modal's cap) with 4 typed mentions placed inline, names past the 120 the
  // sentence keeps, a song with its artist inside an episode, 4 feed npubs,
  // URLs at 512 (the route's cap on a tag item, which the links also are) —
  // this site's own link included — and the summary receipt with long hints.
  const largestArgs = {
    podcast: { ...podcast, title: 'P'.repeat(300), author: 'A'.repeat(300), url: fill(512, 'feed'),
      image: fill(512, 'img'), artwork: fill(512, 'art'), nostrNpubs: many.slice(0, 4) },
    episode: { ...episode, title: 'T'.repeat(300), guid: 'g'.repeat(512 - siteBase), link: fill(512, 'link'),
      image: fill(512, 'epimg'), feedImage: fill(512, 'feedimg') },
    boostagram: { ...boostagram('@m4 @m5 @m6 @m7 ' + 'x'.repeat(250 - 16)), sender_name: 'S'.repeat(300),
      value_msat_total: 9999999999 * 1000 },
    results: [], mentions: many.slice(4),
    track: { split: { title: 'G'.repeat(300), artist: 'R'.repeat(300),
      remoteItem: { feedGuid: 'f'.repeat(200), itemGuid: 'g'.repeat(200) } }, results: [{ ok: true, sats: 1 }] },
    summaryReceipt: RECEIPT,
  };
  const largest = await capture(largestArgs);
  const bannerOf = (e) => (e?.content.match(/https:\/\/\S+\/api\/og\/boost\.png\S*/) ?? [])[0];
  const sentenceOf = (e) => (e?.content.split('\n') ?? []).find((l) => / boosted \d+ sats/.test(l)) ?? '';
  const neventIn = (e) => /nostr:nevent1/.test(e?.content ?? '');
  console.log(`  (the largest real note: ${largest?.content.length} characters)`);
  check('the fixture is at the maximum: both links are 512 characters',
    (largest?.content.split('\n') ?? []).filter((l) => /^https?:\/\/\S+$/.test(l) && l.length === 512).length, 2);
  check('the largest real note fits the limit', largest?.content.length <= LIMIT, true);
  check('...with nothing given way: the song and its artist', sentenceOf(largest).includes(` by ${'R'.repeat(119)}…`), true);
  check('...the banner', !!bannerOf(largest), true);
  check('...and the receipt line', neventIn(largest), true);
  check('...and the limit sits just above it, not far above', LIMIT - (largest?.content.length ?? 0) < 1000, true);
  // BOOST ALL builds its own body: one bullet per paid track, which a DJ mix
  // makes dozens of. Built as components/boost-all-modal.tsx builds it.
  const boostAll = await capture({ ...largestArgs, track: undefined, contentOverride: [
    '⚡ Boost ⚡', '', largestArgs.boostagram.message, '',
    ...boostAllLines({ sender: 'S'.repeat(300), sats: 9999999999, count: 60, showTitle: 'P'.repeat(300),
      each: ' (9999999999 to the artist + 9999999999 to the show, each)',
      tracks: Array.from({ length: 60 }, (_, i) => `${i}`.padEnd(300, 'T')), via: BRAND.wireName }),
  ].join('\n') });
  console.log(`  (BOOST ALL at every real maximum: ${boostAll?.content.length} characters)`);
  check('BOOST ALL at every real maximum fits the limit', boostAll?.content.length <= LIMIT, true);
  check('...it lists twenty tracks, then counts the rest',
    (boostAll?.content.split('\n') ?? []).filter((l) => l.startsWith('• ')).slice(-2).map((l) => l.slice(0, 6)), ['• 19TT', '• and ']);
  check('...counting forty more', boostAll?.content.includes('\n• and 40 more'), true);
  check('...the sentence keeps the full count', sentenceOf(boostAll).includes(' to 60 tracks from '), true);
  check('...and the receipt line stays', neventIn(boostAll), true);

  const banner = new URL(bannerOf(largest) ?? 'https://x/');
  check('the banner carries at most 120 characters of each title',
    [banner.searchParams.get('title')?.length, banner.searchParams.get('ep')?.length], [120, 120]);

  // Past every real maximum: covers at thousands of characters each and titles
  // in a script that percent-encodes nine times over. The picture goes first —
  // never the note, and never the song for the sake of a picture.
  const huge = await capture({ ...largestArgs,
    podcast: { ...largestArgs.podcast, title: '音'.repeat(300), image: fill(3000, 'img'), artwork: fill(3000, 'art') },
    episode: { ...largestArgs.episode, title: '楽'.repeat(300), image: fill(3000, 'epimg'), feedImage: fill(3000, 'feedimg') } });
  check('a note past every real maximum still fits', huge?.content.length <= LIMIT, true);
  check('...the banner gave way', bannerOf(huge), undefined);
  check('...and nothing else: the song stays', sentenceOf(huge).includes(` by ${'R'.repeat(119)}…`), true);
  check('...the receipt line stays', neventIn(huge), true);
  // And relay hints no real relay has, so the receipt line alone is too long:
  // it goes last, after the song and its artist, and its `q` tag stays. The
  // hints are kept under the 5,000 characters bech32 allows a `nevent`, past
  // which nostr-tools throws before any note is built.
  const wss = (n, tag) => fill(n, tag).replace('https', 'wss');
  const hugeReceipt = await capture({ ...largestArgs,
    podcast: { ...largestArgs.podcast, image: fill(3000, 'img'), artwork: fill(3000, 'art') },
    summaryReceipt: { ...RECEIPT, relays: [wss(400, 'r0'), wss(1000, 'r1'), wss(1000, 'r2')] } });
  check('relay hints past every real one: the note still fits', hugeReceipt?.content.length <= LIMIT, true);
  check('...the receipt line gave way', neventIn(hugeReceipt), false);
  check('...after the banner, the song and the "by"', [!!bannerOf(hugeReceipt), / by R/.test(sentenceOf(hugeReceipt))], [false, false]);
  check('...and its q tag stays', hugeReceipt?.tags.filter((t) => t[0] === 'q').map((t) => t[1]), ['a'.repeat(64)]);

  // A link longer than the route takes in an `r` tag is left out — of the tag
  // AND the body, never cut — and the next landing page stands in for it.
  const longLink = await capture({ ...base, episode: { ...episode, link: fill(600, 'link') } });
  check('a landing link over 512 characters is in no r tag', longLink?.tags.some((t) => t[0] === 'r' && t[1].length > 512), false);
  check('...and not in the body', longLink?.content.includes(fill(600, 'link')), false);
  // The order is podcastLandingUrl's: the episode's page, then its guid when
  // that is a URL (this fixture's is), then the show's pages.
  check('...the next landing page stands in', longLink?.content.split('\n').includes(episode.guid), true);
  const longSite = await capture({ ...base, episode: { ...episode, guid: `https://example.com/?${'a=b&'.repeat(70)}` } });
  check('a site link over 512 characters is left out too', longSite?.tags.some((t) => t[0] === 'r' && t[1].length > 512), false);
  check('...of the body as well', /podcast=[^\s]*&episode=/.test(longSite?.content ?? ''), false);

  const worstAlbum = await capture({
    podcast: { ...podcast, medium: 'music', author: 'A'.repeat(300), nostrNpubs: many.slice(0, 4) }, episode: longEp,
    boostagram: boostagram('m'.repeat(280)), results: [], mentions: many,
  });
  check('worst case, a music feed: body within the limit', worstAlbum.content.length <= LIMIT, true);
  check('...and it keeps its "by"', worstAlbum.content.includes(' by A'), true);
  const roomyAlbum = await capture({ ...base, podcast: { ...podcast, medium: 'music', author: 'The Doerfels' } });
  check('a body with room keeps the album\'s "by"', roomyAlbum?.content.includes(` by The Doerfels from ${podcast.title}`), true);
  const roomy = await capture({ ...base, track: { ...track, split: { ...track.split,
    title: 'S'.repeat(300), artist: 'A'.repeat(300) } } });
  check('a body with room keeps the capped line',
    roomy?.content.includes(`to ${'S'.repeat(119)}… by ${'A'.repeat(119)}… from ${episode.title} of ${podcast.title}`), true);
}

// ===========================================================================
console.log('\n--- 5c. A PLAYLIST ROW names its own feed — sentence, tags and art ---');
// ===========================================================================
// rev.hodl's note b1d67bdd… (2026-11-16), as the builder now writes it. The
// container is the ITDV musicL playlist; the row lives in The Doerfels' album
// "Disco Swag - The Album". The old note said "→ ITDV music playlist", tagged
// the playlist's guid with the album's item, and offered the playlist cover as
// banner art — three statements that the playlist is the track's parent.
{
  const ITDV = 'https://raw.githubusercontent.com/ChadFarrow/chadf-musicl-playlists/main/docs/ITDV-music-playlist.webp';
  const playlist = {
    id: 7443423, title: 'ITDV music playlist', author: 'ChadF', medium: 'musicL',
    podcastGuid: '88b0640a-489f-4920-be4f-00f85af5b2d4',
    url: 'https://raw.githubusercontent.com/ChadFarrow/chadf-musicl-playlists/main/docs/ITDV-music-playlist.xml',
    image: ITDV, artwork: ITDV,
  };
  const row = {
    id: 44828612182, title: 'Sing For You', guid: '12711f57-2d41-4794-8cb9-154ecebb7cf7',
    podcastGuid: 'b2a87a4c-86f0-5194-9eb3-dcba42ce0695', feedId: 7571834, feedTitle: 'Disco Swag - The Album',
    image: 'https://www.doerfelverse.com/art/sing-for-you.png',
    feedImage: 'https://www.doerfelverse.com/art/discoswag-thealbum.gif',
    enclosureUrl: 'https://www.doerfelverse.com/tracks/sing-for-you.mp3', datePublished: 1762493210,
  };
  const rowBoostagram = { ...boostagram('This is catchy.'), podcast: playlist.title, episode: row.title,
    value_msat_total: 121000, sender_name: 'rev.hodl' };
  const note = await publishBoostNote({
    podcast: playlist, episode: row, boostagram: rowBoostagram, results: [], relays: [RELAY],
    itemArtist: 'The Doerfels',
  });
  await wait(400);
  const e = received.find((x) => x.id === note.id);
  check('the playlist note reached the relay', !!e, true);
  check('the sentence names the track, its artist, then the playlist',
    e?.content.includes('rev.hodl boosted 121 sats to Sing For You by The Doerfels from ITDV music playlist via BoostMeBitch'), true);
  check('the item\'s OWN feed is the first show tag, then the item, then the playlist',
    e?.tags.filter((t) => t[0] === 'i').map((t) => t[1]), [
      'podcast:guid:b2a87a4c-86f0-5194-9eb3-dcba42ce0695',
      'podcast:item:guid:12711f57-2d41-4794-8cb9-154ecebb7cf7',
      'podcast:guid:88b0640a-489f-4920-be4f-00f85af5b2d4',
    ]);
  check('one k tag per kind, as before', e?.tags.filter((t) => t[0] === 'k').map((t) => t[1]),
    ['podcast:guid', 'podcast:item:guid']);
  const banner = new URL((e?.content.match(/https:\/\/\S+\/api\/og\/boost\.png\S*/) ?? ['https://x/'])[0]);
  check('the banner offers the track and album art', [banner.searchParams.get('art'), banner.searchParams.get('art2')],
    [row.image, row.feedImage]);
  check('...and never the playlist cover', [...banner.searchParams.values()].includes(ITDV), false);

  // Without the lookup's answer the note still says what and where.
  const noArtist = await publishBoostNote({
    podcast: playlist, episode: row, boostagram: rowBoostagram, results: [], relays: [RELAY],
  });
  await wait(400);
  check('an artist the lookup did not return is left out, nothing else',
    received.find((x) => x.id === noArtist.id)?.content.includes('rev.hodl boosted 121 sats to Sing For You from ITDV music playlist via BoostMeBitch'), true);
}

// PC20-Nostr pc20-boost-notes.md (#51): the order of the `i` tags (rule 15)
// and of the body's blocks (rule 12). Wiring the builder owns, so here.
{
  const P = '11111111-1111-4111-8111-111111111111'; // the playlist
  const F = '22222222-2222-4222-8222-222222222222'; // the episode's own feed
  const E = 'episode-146-guid';
  const B = 'e88a4a67-877c-5e03-b8fd-a70cebc821af'; // the song's album
  const S = '9f515f93-eda1-4146-8637-7def160879b5'; // the song
  const podL = { id: 9, title: 'Pod Picks', author: 'A Curator', medium: 'podcastL', podcastGuid: P,
    url: 'https://example.com/picks.xml' };
  const row = { id: 10, title: 'Episode 146', guid: E, podcastGuid: F, feedTitle: 'Homegrown Hits',
    enclosureUrl: 'https://example.com/146.mp3', datePublished: 1 };
  const song = {
    split: { title: 'Copenhagen Time', artist: 'Matt Finlay', remoteItem: { feedGuid: B, itemGuid: S } },
    results: [{ ok: true, sats: 340 }],
  };
  const note = await publishBoostNote({
    podcast: podL, episode: row, boostagram: boostagram('nice'), results: [], relays: [RELAY], track: song,
  });
  await wait(400);
  const e = received.find((x) => x.id === note.id);
  check('a playlist row with a paid song reached the relay', !!e, true);
  check('rule 15: the item\'s pair, then the song\'s, then the playlist',
    e?.tags.filter((t) => t[0] === 'i').map((t) => t[1]),
    [`podcast:guid:${F}`, `podcast:item:guid:${E}`, `podcast:guid:${B}`, `podcast:item:guid:${S}`, `podcast:guid:${P}`]);

  const quoted = await publishBoostNote({
    podcast, episode, boostagram: boostagram('nice'), results: [], relays: [RELAY],
    summaryReceipt: { id: 'a'.repeat(64), pubkey: pk, relays: [RELAY] },
  });
  await wait(400);
  const q = received.find((x) => x.id === quoted.id);
  const at = (re) => (q?.content ?? '').search(re);
  check('a note with a mention and a quoted receipt reached the relay', !!q, true);
  check('...carries both', [at(/nostr:npub1/) >= 0, at(/nostr:nevent1/) >= 0], [true, true]);
  check('rule 12: the mentions come before the quoted receipt', at(/nostr:npub1/) < at(/nostr:nevent1/), true);
  check('...so the receipt is the last line', /^nostr:nevent1\S+$/.test((q?.content ?? '').split('\n').at(-1)), true);
}

// ===========================================================================
console.log('\n--- 6. Nothing left this machine ---');
// ===========================================================================
if (!ISOLATED) {
  skipped += 1;
  console.log('  SKIPPED (not isolated) — the claim this makes is false here by construction.');
  check('every event this run produced landed on the LOCAL relay',
    received.every((e) => !!e.id), true);
} else {
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
// A partial run must not read as a full one. `ok` alone is the claim that
// everything here passed; when a section was skipped the line says which.
console.log(`\n${t.fails ? `${t.fails} FAILED` : 'ok'}${skipped ? ` (${skipped} section(s) SKIPPED — not isolated)` : ''}`);
await exit(t.fails ? 1 : 0);
