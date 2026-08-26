// Pins src/ingest.ts — the decisions that let an event into this index, and
// the shape it takes once inside.
//
// Loads the SHIPPING module (`../src/ingest.ts`) under `node
// --experimental-strip-types`. A reimplemented copy here would stay green while
// the real module drifted, which is the exact failure this shape prevents.
//
// EVERY vector is recorded as a CALL — `{ fn, args, expect }` — and the replay
// at the foot of this file walks the whole list twice: once against the real
// module, once against `naive()`. So a vector cannot be added without also
// being proved to discriminate. A legitimate input that the wrong
// implementation also handles is a property of that input, not a hole, and is
// exempted ONE AT A TIME with `alsoNaive: true` — never by default.
//
// Fixtures are signed with real keys through nostr-tools' own `finalizeEvent`,
// so every signature here is genuine wire-shaped output rather than a string
// that looks like one. Two shapes of forgery are covered and they are NOT the
// same test: a JSON round trip (what arrives off a relay socket) and an object
// SPREAD (`{ ...trusted, id, sig }`). The second is the one that bites —
// nostr-tools memoizes its verification result on a Symbol property, spread
// copies symbol properties, and a forged event built that way inherited a
// `true` for a body it had just replaced. It was accepted and stored.

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  classify, deletionTargets, indexableTags, podcastRefs, trackedFrom,
} from '../src/ingest.ts';

let failures = 0;
let checks = 0;

function eq(actual, expected, what) {
  checks++;
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    failures++;
    console.error(`FAIL ${what}\n  expected ${b}\n  actual   ${a}`);
    return false;
  }
  return true;
}

// --- fixtures ---------------------------------------------------------------

const SK = generateSecretKey();
const PK = getPublicKey(SK);
const OTHER_SK = generateSecretKey();
const NOW = 1_750_000_000;
const P1 = '11'.repeat(32);
const P2 = '22'.repeat(32);
const FEED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const sign = (tpl, sk = SK) => finalizeEvent({ created_at: NOW, content: '', tags: [], ...tpl }, sk);

/** What a relay actually hands you: bytes through JSON.parse, no symbols. */
const overTheWire = (e) => JSON.parse(JSON.stringify(e));

const boost = sign({
  kind: 1,
  content: 'Boosted 100 sats',
  tags: [
    ['k', 'podcast:guid'],
    ['i', `podcast:guid:${FEED}`],
    ['description', 'multi-char tag name, not relay-indexable'],
    ['i', 'podcast:item:guid:item-123'],
    ['p', P1],
    ['t', 'boostagram'],
    ['e', ''],
  ],
});

// Tampered content, original signature. Built by SPREAD on purpose.
const forgedBySpread = { ...boost, content: 'Boosted 100000 sats' };
// Tampered content, and the id recomputed nowhere - the wire form.
const forgedOverWire = overTheWire({ ...boost, content: 'Boosted 100000 sats' });

const profile = sign({ kind: 0, content: JSON.stringify({ name: 'A', banner: 'B' }) });
const repost = sign({ kind: 6, tags: [['e', 'ab'.repeat(32)]] });
const zapReceipt = sign({ kind: 9735, tags: [['p', P1], ['P', P2]] });
const ownDeletion = sign({ kind: 5, tags: [['e', 'cd'.repeat(32)], ['e', 'cd'.repeat(32)], ['e', 'short'], ['a', '30311:x:y']] });
const emptyDeletion = sign({ kind: 5, tags: [['a', '30311:x:y']] });
const followList = sign({ kind: 3, tags: [['p', P1]] });
const favorites = sign({ kind: 10333, tags: [['i', `podcast:guid:${FEED}`]] });
const muteList = sign({ kind: 10000, content: 'nip04-ciphertext' });
const walletBackup = sign({ kind: 30078, tags: [['d', 'boostmebitch:wallet:nwc']] });
const dm = sign({ kind: 4, tags: [['p', P1]] });
const relayList = sign({ kind: 10002, tags: [['r', 'wss://relay.example']] });
const liveStream = sign({ kind: 30311, tags: [['d', 'stream1']] });
const itemOnly = sign({ kind: 1, tags: [['i', 'podcast:item:guid:orphan-item']] });
// Tag ORDER is not guaranteed on the wire. A note may name the item before the
// feed it belongs to, and a parser that pairs an item against "whatever feed I
// have seen so far" writes an empty parent for it.
const itemBeforeFeed = sign({
  kind: 1,
  tags: [['i', 'podcast:item:guid:item-9'], ['i', `podcast:guid:${FEED}`]],
});
const malformed = { ...overTheWire(boost), sig: 'too-short' };

// --- the vectors ------------------------------------------------------------
//
// `alsoNaive: true` marks an input the wrong implementation happens to get
// right too. Each one carries its reason.

const VECTORS = [
  // classify - what may enter the index at all
  { fn: 'classify', args: [overTheWire(boost)], expect: { type: 'store' },
    why: 'an ordinary boost note is stored', alsoNaive: true },
  { fn: 'classify', args: [forgedBySpread],
    expect: { type: 'reject', reason: 'bad-signature' },
    why: 'SPREAD forgery: inherits the memoized verification symbol' },
  { fn: 'classify', args: [forgedOverWire],
    expect: { type: 'reject', reason: 'bad-signature' },
    why: 'wire forgery: tampered content against an untouched signature' },
  { fn: 'classify', args: [malformed],
    expect: { type: 'reject', reason: 'malformed' },
    why: 'shape check runs before the signature check' },
  { fn: 'classify', args: [overTheWire(profile)], expect: { type: 'profile' },
    why: 'kind:0 goes to the profiles table', alsoNaive: true },
  { fn: 'classify', args: [overTheWire(repost)], expect: { type: 'store' },
    why: 'kind:6 reposts are stored', alsoNaive: true },
  { fn: 'classify', args: [overTheWire(zapReceipt)], expect: { type: 'store' },
    why: 'kind:9735 zap receipts are stored', alsoNaive: true },
  { fn: 'classify', args: [overTheWire(ownDeletion)],
    expect: { type: 'delete', targets: ['cd'.repeat(32)] },
    why: 'kind:5 tombstones, deduped, 64-hex only' },
  { fn: 'classify', args: [overTheWire(emptyDeletion)],
    expect: { type: 'reject', reason: 'empty-deletion' },
    why: 'an a-tag-only kind:5 addresses a replaceable event we do not tombstone' },

  // classify - the kinds that must NEVER be indexed. Each is a separate
  // vector: one shared assertion would let a single missing entry hide.
  { fn: 'classify', args: [overTheWire(followList)],
    expect: { type: 'reject', reason: 'forbidden-kind' },
    why: 'kind:3 follows - a blind republish wipes a follow list' },
  { fn: 'classify', args: [overTheWire(favorites)],
    expect: { type: 'reject', reason: 'forbidden-kind' },
    why: 'kind:10333 favorites - a stale read deletes what another app wrote' },
  { fn: 'classify', args: [overTheWire(muteList)],
    expect: { type: 'reject', reason: 'forbidden-kind' },
    why: 'kind:10000 mutes - the private half is NIP-04 ciphertext' },
  { fn: 'classify', args: [overTheWire(walletBackup)],
    expect: { type: 'reject', reason: 'forbidden-kind' },
    why: 'kind:30078 - encrypted wallet and settings backups' },
  { fn: 'classify', args: [overTheWire(dm)],
    expect: { type: 'reject', reason: 'forbidden-kind' },
    why: 'kind:4 direct messages' },
  { fn: 'classify', args: [overTheWire(relayList)],
    expect: { type: 'reject', reason: 'forbidden-kind' },
    why: 'kind:10002 - relay lists belong to the outbox model, not to a cache' },
  { fn: 'classify', args: [overTheWire(liveStream)],
    expect: { type: 'reject', reason: 'unindexed-kind' },
    why: 'kind:30311 is simply not in the storable set' },

  // indexableTags - pos is the ORIGINAL ordinal, gaps and all
  { fn: 'indexableTags', args: [boost],
    expect: [
      { name: 'k', value: 'podcast:guid', pos: 0 },
      { name: 'i', value: `podcast:guid:${FEED}`, pos: 1 },
      { name: 'i', value: 'podcast:item:guid:item-123', pos: 3 },
      { name: 'p', value: P1, pos: 4 },
      { name: 't', value: 'boostagram', pos: 5 },
    ],
    why: 'pos 2 is absent (multi-char name) and pos 6 is absent (empty value): a renumbered pos would claim 1 and 3 were adjacent' },

  // deletionTargets
  { fn: 'deletionTargets', args: [ownDeletion], expect: ['cd'.repeat(32)],
    why: 'deduped, and a non-64-char e value is not an event id' },

  // podcastRefs - an item is useless without its parent feed
  { fn: 'podcastRefs', args: [boost],
    expect: { feedGuids: [FEED], items: [{ feedGuid: FEED, itemGuid: 'item-123' }] },
    why: 'item paired to the feed named on the same note', alsoNaive: true },
  { fn: 'podcastRefs', args: [itemBeforeFeed],
    expect: { feedGuids: [FEED], items: [{ feedGuid: FEED, itemGuid: 'item-9' }] },
    why: 'item tag BEFORE its feed tag still pairs: a running-parent parser writes an empty feedGuid here' },
  { fn: 'podcastRefs', args: [itemOnly], expect: { feedGuids: [], items: [] },
    why: 'PI cannot look an item up without a podcastguid, so an orphan item is never queued' },

  // trackedFrom - author AND p-tags; this is what scopes the kind:9735 filter
  { fn: 'trackedFrom', args: [boost],
    expect: [{ pubkey: PK, reason: 'author' }, { pubkey: P1, reason: 'p-tagged' }],
    why: 'p-tagged pubkeys are tracked too, or a boost recipient never gets their zaps indexed' },
  { fn: 'trackedFrom', args: [zapReceipt],
    expect: [{ pubkey: PK, reason: 'author' }, { pubkey: P1, reason: 'p-tagged' }],
    why: 'uppercase P is not a p tag; only the lowercase recipient counts' },
];

// --- the obvious wrong implementation --------------------------------------
//
// Every one of these is a thing somebody would plausibly write. None is a straw
// man: skipping verification because "the relay already checked it", numbering
// pos as you emit rows, letting any kind:5 delete, queueing an item guid on its
// own, tracking only the author.

function naive() {
  return {
    classify(event) {
      if (event.kind === 0) return { type: 'profile' };
      if (event.kind === 5) return { type: 'delete', targets: event.tags.filter((t) => t[0] === 'e').map((t) => t[1]) };
      return { type: 'store' };
    },
    indexableTags(event) {
      const out = [];
      for (const t of event.tags) {
        if (typeof t[0] === 'string' && t[0].length === 1 && t[1]) {
          out.push({ name: t[0], value: t[1], pos: out.length });
        }
      }
      return out;
    },
    deletionTargets(event) {
      return event.tags.filter((t) => t[0] === 'e').map((t) => t[1]);
    },
    podcastRefs(event) {
      const feedGuids = [];
      const items = [];
      for (const t of event.tags) {
        if (t[0] !== 'i' || typeof t[1] !== 'string') continue;
        if (t[1].startsWith('podcast:item:guid:')) {
          items.push({ feedGuid: feedGuids[0] ?? '', itemGuid: t[1].slice('podcast:item:guid:'.length) });
        } else if (t[1].startsWith('podcast:guid:')) {
          feedGuids.push(t[1].slice('podcast:guid:'.length));
        }
      }
      return { feedGuids, items };
    },
    trackedFrom(event) {
      return [{ pubkey: event.pubkey, reason: 'author' }];
    },
  };
}

// --- total replay -----------------------------------------------------------

const REAL = { classify, deletionTargets, indexableTags, podcastRefs, trackedFrom };
const NAIVE = naive();

console.log(`replaying ${VECTORS.length} vectors against the shipping module`);
for (const v of VECTORS) {
  eq(REAL[v.fn](...v.args), v.expect, `${v.fn}: ${v.why}`);
}

console.log('replaying the same vectors against naive() - each must differ, or be exempted');
let exempted = 0;
for (const v of VECTORS) {
  if (v.alsoNaive) { exempted++; continue; }
  checks++;
  let got;
  try {
    got = JSON.stringify(NAIVE[v.fn](...v.args));
  } catch {
    got = '<threw>';
  }
  if (got === JSON.stringify(v.expect)) {
    failures++;
    console.error(`FAIL naive() agrees with vector "${v.fn}: ${v.why}" - it discriminates nothing.`);
    console.error('  Either the vector is not testing what it claims, or naive() is not the tempting wrong version.');
    console.error("  Do NOT silence this with alsoNaive unless the input genuinely cannot discriminate.");
  }
}

console.log(`\n${checks} checks, ${VECTORS.length - exempted} discriminating vectors, ${exempted} exempted`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
console.log('ok');
