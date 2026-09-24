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

const { publishBoostNote, publishBoostNoteViaSite } =
  await import('../lib/nostr/boost-notes.ts');
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
  check('the 🎵 line sits right under the 📻 line',
    lines[lines.indexOf(`📻 ${episode.title}`) + 1], '🎵 Copenhagen Time — Matt Finlay');
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
    // ok:false stops publishBoostNoteViaSite before it publishes anywhere.
    globalThis.fetch = async (_u, init) => { sent = JSON.parse(init.body); return { ok: false, status: 599, json: async () => ({}) }; };
    await publishBoostNoteViaSite(args).catch(() => {});
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
  check('the site path carries the 🎵 line too', paid?.content.includes('🎵 Copenhagen Time — Matt Finlay'), true);
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
  const worstNoTrack = await capture({
    podcast: { ...podcast, nostrNpubs: many.slice(0, 4) }, episode: longEp,
    boostagram: boostagram('m'.repeat(280)), results: [], mentions: many,
  });
  check('worst case: body within 2000', worst.content.length <= 2000, true);
  // Without the track this body is already within a few characters of the
  // cap, and the line adds up to ~250: it must be the line that goes, never
  // the note.
  check('worst case: a body the line would overfill drops the LINE',
    worst.content, worstNoTrack.content);
  check('...while the track tags still ride', worst.tags.filter((t) => t[0] === 'i').length, 4);
  const roomy = await capture({ ...base, track: { ...track, split: { ...track.split,
    title: 'S'.repeat(300), artist: 'A'.repeat(300) } } });
  check('a body with room keeps the capped line',
    roomy?.content.includes(`🎵 ${'S'.repeat(119)}… — ${'A'.repeat(119)}…`), true);
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
