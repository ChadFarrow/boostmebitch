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
//
// NOTHING LEAVES THIS MACHINE, and it is ENFORCED: the first import below
// replaces the global WebSocket before nostr-tools loads, with one that opens
// to 127.0.0.1 only and ends the run on any other URL. See the section after
// the signer for why that replaced a probe, and what it cost.

// FIRST, before anything that imports nostr-tools. Moving it down disarms it.
import { relayGuard, expectRefusal } from './no-public-relays.mjs';
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

// NOTHING MAY LEAVE THIS MACHINE, and it is enforced rather than checked.
//
// THIS USED TO BE A PROBE, AND IT LEAKED. The script opened a socket to each of
// the four DEFAULT_RELAYS, and when one answered it skipped section 2 — the one
// section it believed published to them, because publishBoostNoteViaSite took
// no `relays` argument. Section 5b called that same function, through
// `capture()`, thirteen times a run, under a comment saying it "runs only
// isolated"; its stamp stand-in answers 599, so every call signed with a
// one-time key and published. Nine runs on 2026-11-17 put 117 test notes on
// relay.primal.net and relay.fountain.fm, under keys nobody holds, so they can
// never be deleted — every feed here hides them now
// (lib/nostr/test-boost-notes.ts), and other apps showed them.
//
// So now:
//   - every publish names this machine's relay, including both site-signed
//     sections (publishBoostNoteViaSite takes `relays` since then);
//   - the first import replaces the global WebSocket with one that opens to
//     127.0.0.1 only, and ENDS THE RUN on any other URL before a byte is sent
//     (scripts/no-public-relays.mjs). No list of "unsafe sections" to keep
//     right: a section added tomorrow that reaches for a public relay stops the
//     run the moment it tries;
//   - the guard proves it is in front of the shipping publish path before
//     anything runs (the self-test below), or the script refuses to run. An
//     earlier in-process guard recorded nothing and reported success, which a
//     guard with nothing to block also does — this one must refuse a URL.
//
// Every section runs on every machine. There is no isolation to detect.

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
console.log('--- 0. The guard stands in front of the function that leaked ---');
// ===========================================================================
// Before anything publishes: aim publishBoostNoteViaSite — the function whose
// one-time-key notes leaked — at a public-looking relay, and require the guard
// to refuse it. A guard that is not in the path refuses nothing, so this run
// stops here instead of trusting it. The host is `.invalid` (RFC 2606): were
// the guard missing, the connection would still fail on DNS and carry nothing.
{
  const GUARD_PROBE = 'wss://e2e-relay-guard.invalid';
  const realFetch = globalThis.fetch;
  // The stamp route's 599 sends the ladder to the one-time key, then to publish.
  globalThis.fetch = async () => ({ ok: false, status: 599, json: async () => ({}) });
  const refused = await expectRefusal(GUARD_PROBE, () => publishBoostNoteViaSite(
    { podcast, episode, boostagram: boostagram('guard self-test'), results: [] },
    { payStamp: async () => {}, state: {}, relays: [GUARD_PROBE] },
  ));
  globalThis.fetch = realFetch;
  if (!refused) {
    console.error('  REFUSING TO RUN: the relay guard did not see a publish aimed at a public URL.');
    console.error('  It must be the FIRST import of this file (scripts/no-public-relays.mjs).');
    relay.close?.();
    process.exit(1);
  }
  console.log(`  ok    a publish aimed at ${GUARD_PROBE} was refused before it connected`);
}

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
console.log('\n--- 2. SITE-SIGNED: the sender\'s mention is body-only ---');
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
  // `relays: [RELAY]`: this machine's relay, like every other section. This
  // section was once SKIPPED on any machine with internet, because the
  // function could only publish to DEFAULT_RELAYS (see the top of the file).
  const out = await publishBoostNoteViaSite({
    podcast, episode, boostagram: boostagram('great track @fiatjaf'),
    results: [], mentions: [mentionA],
  }, { payStamp: async () => {}, state: {}, relays: [RELAY] });
  await wait(400);
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
  // The relay round trip, which this section could not assert while it could
  // only publish to the public relays.
  const landed = received.find((x) => x.id === out.note.id);
  check('the site-signed note reached THIS MACHINE\'s relay', !!landed, true);
  check('...signed by the site key the stand-in route used', landed?.pubkey, getPublicKey(siteSk));
  check('...and the relay it names is the local one, and only that one',
    JSON.stringify(out.note.acceptedRelays), JSON.stringify([RELAY]));
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
  // And on the USER's key: section 2's site-signed note lands here too now,
  // and it is the one that must NOT p-tag the mention.
  const back = await pool.querySync([RELAY], { kinds: [1], '#t': ['boostagram'], authors: [pk] });
  check('every self-signed boost note is queryable', back.length, 3);
  const tagged = back.filter((e) => e.tags.some((t) => t[0] === 'p' && t[1] === mentionA.pubkey));
  check('all three p-tag the mentioned person', tagged.length, 3);
  pool.close([RELAY]);
}

// ===========================================================================
console.log('\n--- 5a. An episode page with an /@handle in it stays out of the body ---');
// ===========================================================================
// The body USED to carry the episode's own page, from RSS <link>. On a
// Castopod show that page is https://host/@<handle>/episodes/<slug>, so a
// sender who @mentioned someone named "<handle>" broke a link they never
// typed: the mention step replaced the name everywhere in the body. Since
// 2026-11-22 the body carries no listen link at all (the site's host is
// its one link), so the page cannot be broken in it — this pins that it stays
// out, and that the mention still lands. e2e:mentionlinks covers a link the
// SENDER typed, through the real picker. After section 5 on purpose, so its
// count of boost notes is not moved.
{
  const castopod = 'https://castopod.example/@handle/episodes/ep-1';
  const note = await publishBoostNote({
    podcast, episode: { ...episode, link: castopod }, boostagram: boostagram('thanks @handle'),
    results: [], relays: [RELAY], mentions: [{ ...mentionA, name: 'handle' }],
  });
  await wait(400);
  const e = received.find((x) => x.id === note.id);
  check('the Castopod note reached the relay', !!e, true);
  check('the episode page is not in the body', e?.content.includes('castopod.example'), false);
  check('...nor in an r tag', e?.tags.some((t) => t[0] === 'r' && t[1].includes('castopod.example')), false);
  check('...and no URI was written into a link', e?.content.includes('/nostr:'), false);
  check('the typed @handle became the URI', e?.content.includes(`thanks nostr:${mentionA.npub}`), true);
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
  // A 599 from the stamp route makes the ladder sign with a ONE-TIME key and
  // PUBLISH. That is the publish that leaked: this comment once said the section
  // "runs only isolated, so that publish reaches nobody", and it ran everywhere,
  // thirteen times a run, onto DEFAULT_RELAYS. It goes to this machine's relay
  // now (`relays: [RELAY]`), and the guard ends the run if it ever does not.
  const oneTimeIds = [];
  const capture = async (args) => {
    let sent = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (_u, init) => {
      sent ??= JSON.parse(init.body).template;
      return { ok: false, status: 599, json: async () => ({}) };
    };
    try {
      const out = await publishBoostNoteViaSite(args, { payStamp: async () => {}, state: {}, relays: [RELAY] });
      oneTimeIds.push(out.note.id);
    } catch {
      oneTimeIds.push(null);
    } finally {
      globalThis.fetch = realFetch;
    }
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

  // The route's OWN rules, not a mirror of them: every template the builder
  // makes must pass validateBoostTemplate (lib/site-sign-template.ts), which
  // both site-key routes call. A mirror is how a long `i` tag item reached the
  // route: the item guid is feed-chosen, has no maximum, and one item past
  // MAX_TAG_ITEM_LEN refused the WHOLE note.
  const { validateBoostTemplate } = await import('../lib/site-sign-template.ts');
  const SITE_HEX = nip19.decode(BRAND.siteNpub).data;
  const routeTakes = (t) => {
    try { validateBoostTemplate(t, SITE_HEX, { checkCreatedAt: false }); return true; } catch (e) { return e.message; }
  };
  check('the route takes the plain note', routeTakes(plain), true);
  check('the route takes the worst case', routeTakes(worst), true);
  const hugeGuid = `https://example.com/${'h'.repeat(700)}`;
  const longItem = await capture({
    ...base, episode: { ...episode, guid: hugeGuid },
    track: { split: { title: 'Song', artist: 'Artist',
      remoteItem: { feedGuid: 'f'.repeat(600), itemGuid: 'g'.repeat(600) } }, results: [{ ok: true, sats: 1 }] },
  });
  check('an item guid past 512: the route still takes the note', routeTakes(longItem), true);
  check('...every tag item is within 512', longItem.tags.every((t) => t.every((x) => x.length <= 512)), true);
  check('...the long item\'s own `i` tag is left out, not cut',
    longItem.tags.some((t) => t[0] === 'i' && t[1].includes('hhhh')), false);
  check('...and so is its `k`', longItem.tags.some((t) => t[0] === 'k' && t[1] === 'podcast:item:guid'), false);
  check('...while the show\'s `i` tag stays',
    longItem.tags.some((t) => t[0] === 'i' && t[1] === `podcast:guid:${podcast.podcastGuid}`), true);
  check('...and the body still names the song', longItem.content.includes('Song'), true);

  // The `imeta` is the WHOLE tag, not its first entry. NIP-92 makes each
  // element a `<key> <value>` pair a client reads, so the banner first and a
  // stranger's host after it is a signed instruction, under the site's name,
  // to load that host from every reader's device.
  const bannerTag = plain.tags.find((t) => t[0] === 'imeta');
  check('the plain note carries the banner `imeta`', bannerTag?.length, 4);
  const EVIL = 'https://evil.example/x.png';
  for (const [label, bad] of [
    ['a fallback after the banner', [...bannerTag, `fallback ${EVIL}`]],
    ['a second url in place of dim', ['imeta', bannerTag[1], 'm image/png', `url ${EVIL}`]],
    ['a thumb in place of m', ['imeta', bannerTag[1], `thumb ${EVIL}`, 'dim 1200x300']],
    ['a key hidden after a space in the banner url', ['imeta', `${bannerTag[1]} fallback ${EVIL}`, 'm image/png', 'dim 1200x300']],
    ['another host as the url', ['imeta', `url ${EVIL}`, 'm image/png', 'dim 1200x300']],
  ]) {
    const t = { ...plain, tags: plain.tags.map((x) => (x[0] === 'imeta' ? bad : x)) };
    check(`the route refuses an imeta with ${label}`, routeTakes(t), 'invalid imeta tag');
  }

  const fill = (n, tag) => { const h = `https://example.com/${tag}/`; return h + 'x'.repeat(n - h.length); };
  // The receipt's hints are relays the user writes to, and a real one can be
  // long: filter.nostr.wine puts the npub and a query in the URL. Three of
  // those, the most the nevent carries.
  const relayHints = many.slice(0, 3).map((m) => `wss://filter.nostr.wine/${m.npub}?broadcast=true`);
  // The signed receipt rides with the quote: site-stamp refuses one that claims
  // more than the note (lib/site-stamp.ts, `quotedReceiptFits`), and the page
  // checks its fields before it asks. 1 sat is under every note here.
  const RECEIPT = {
    id: 'a'.repeat(64), pubkey: 'b'.repeat(64), relays: relayHints,
    event: { id: 'a'.repeat(64), pubkey: 'b'.repeat(64), kind: 9735, created_at: 0, content: '', tags: [['amount', '1000']], sig: '' },
  };
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
  // The body prints no link but the site's host since 2026-11-22; the
  // deep link at its 512 is the `r` tag, and the tags have their own cap.
  check('the fixture is at the maximum: the site link is 512 characters',
    largest?.tags.filter((t) => t[0] === 'r').map((t) => t[1].length), [512]);
  check('...and the body prints no link line but the site\'s host',
    (largest?.content.split('\n') ?? []).filter((l) => /^https?:\/\//.test(l) && !/\/api\/og\/boost\.png/.test(l)), []);
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

  // No listen link since 2026-11-22: not the episode's page, not its URL guid,
  // not pod.link, Podcast Index or the feed — in the body or in an `r` tag.
  const withPage = await capture({ ...base, episode: { ...episode, link: 'https://example.com/episode-page' } });
  check('the episode\'s page is in no r tag', withPage?.tags.some((t) => t[0] === 'r' && t[1].includes('episode-page')), false);
  check('...and not in the body', withPage?.content.includes('episode-page'), false);
  check('...nor its URL guid', withPage?.content.split('\n').includes(episode.guid), false);
  const listed = await capture({ ...base, podcast: { ...podcast, itunesId: 1234 }, episode: { ...episode, guid: 'plain-guid' } });
  check('pod.link, Podcast Index and the feed are in neither',
    [listed?.content, ...(listed?.tags.map((t) => t.join(' ')) ?? [])].some((x) => /pod\.link|podcastindex\.org\/podcast|example\.com\/feed\.xml/.test(x ?? '')), false);
  // This site's deep link over 512 characters is left out of its `r` tag, never cut.
  const longSite = await capture({ ...base, episode: { ...episode, guid: `https://example.com/?${'a=b&'.repeat(70)}` } });
  check('a site link over 512 characters is left out too', longSite?.tags.some((t) => t[0] === 'r' && t[1].length > 512), false);
  check('...and the body never prints the deep link', /podcast=[^\s]*&episode=/.test(longSite?.content ?? ''), false);

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

  // Every one-time-key note above was PUBLISHED. Each must be on this
  // machine's relay — the proof the leak path now ends here.
  await wait(400);
  check('every one-time-key publish in this section succeeded', oneTimeIds.includes(null), false);
  check(`...and all ${oneTimeIds.length} landed on THIS MACHINE's relay`,
    oneTimeIds.every((id) => received.some((x) => x.id === id)), true);
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
console.log('\n--- 5d. ONE link, to this site, with no scheme ---');
// ===========================================================================
// Chad, 2026-11-22, on a note in jumble.social: the show's art three times — a
// card for the listen link (podcastindex.org), a card for this site's deep
// link, and the banner. Every client read that day draws a card for an
// `https://` URL and none for a host with no scheme (docs/nostr.md, "ONE link
// in the body, with no scheme"). So the body names this site as `www.boostmebitch.com`,
// between the sentence and the banner (the shared format's block order), and
// carries no other link; the deep link stays in the one `r` tag and the hints.
{
  const SITE_LINE = new URL(BRAND.origin).host;
  const deep = siteLandingUrl(podcast.podcastGuid, episode.guid);
  const note = await publishBoostNote({
    podcast: { ...podcast, itunesId: 1234 }, episode: { ...episode, link: 'https://example.com/episode-page' },
    boostagram: boostagram('one link'), results: [], relays: [RELAY],
  });
  await wait(400);
  const e = received.find((x) => x.id === note.id);
  const lines = e?.content.split('\n') ?? [];
  const at = (want) => lines.findIndex((l) => want(l));
  check('the one-link note reached the relay', !!e, true);
  check('the body names this site by its host, with no scheme', lines.filter((l) => l === SITE_LINE).length, 1);
  check('...the www host, which every link to this site uses', SITE_LINE.startsWith('www.'), true);
  check('...after the sentence, before the banner',
    [at((l) => / boosted \d+ sats/.test(l)) < at((l) => l === SITE_LINE),
      at((l) => l === SITE_LINE) < at((l) => /\/api\/og\/boost\.png/.test(l))], [true, true]);
  check('no other link line: the banner is the only https:// in the body',
    lines.filter((l) => /https?:\/\//.test(l)).map((l) => /\/api\/og\/boost\.png/.test(l)), [true]);
  check('one r tag: the deep link', e?.tags.filter((t) => t[0] === 'r').map((t) => t[1]), [deep]);
  check('...which the item\'s i hint names too',
    e?.tags.find((t) => t[0] === 'i' && t[1] === `podcast:item:guid:${episode.guid}`)?.[2], deep);
  check('the banner keeps its imeta', e?.tags.some((t) => t[0] === 'imeta'), true);
  check('the feed npub keeps its p tag', pTags(e ?? { tags: [] }).includes(feedA.pubkey), true);
}

// ===========================================================================
console.log('\n--- 6. Nothing left this machine ---');
// ===========================================================================
// Enforced, not probed: the guard refuses every non-local socket and ENDS the
// run on any but section 0's probe, so reaching this line already means none
// was attempted. These checks hold the guard to having been in the path — an
// earlier guard recorded nothing and passed, which is what an absent one does.
{
  const opened = new Set(relayGuard.opened.map((u) => new URL(u).host));
  check('the guard saw this run\'s publishes (it opened the local relay)', opened.size > 0, true);
  check('...and the local relay is the ONLY place a socket was opened to',
    [...opened], [new URL(RELAY).host]);
  check('the only socket refused was section 0\'s probe',
    [...new Set(relayGuard.refused.map((u) => new URL(u).hostname))], ['e2e-relay-guard.invalid']);
  check('every event this run produced landed on the LOCAL relay',
    received.every((e) => !!e.id), true);
}

relay.close?.();
console.log(`\n${t.fails ? `${t.fails} FAILED` : 'ok'}`);
await exit(t.fails ? 1 : 0);
