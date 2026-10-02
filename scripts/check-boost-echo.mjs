// Pins `boostEchoIds` (lib/nostr/boost-echo.ts) — which bot announcement of a
// boost a feed hides because the note the SENDER signed about it is on screen.
//
// Usage:
//   npm run check:echo
//
// THE REPORT THIS IS WRITTEN AGAINST (2026-10-02). The global feed showed one
// 500-sat boost as two cards: Quincy Simon's own Fountain note, and MSP 2.0's
// bot announcing the same payment 3 s earlier. Both are real signed events by
// two keys, so the id dedupe in the read index and in `mergeNotes` never sees
// them. The note the sender signed stays; the announcement goes.
//
// WHY THIS EARNS A CHECK SCRIPT. Each wrong version fails silently in one of two
// directions: a boost on two cards, which is the report, or a SECOND boost taken
// off the feed, which nobody reports because nothing on screen says a card is
// missing. The obvious version — "hide a note whose `sender` has a note in the
// list" — is `naive()` below, and it does the second: a different track, an hour
// apart, a different amount, a second announcement of a second boost, all
// hidden.
//
// THE FIXTURES ARE FROM THE WIRE, fetched from relay.damus.io / nos.lol /
// relay.primal.net on 2026-10-02: the screenshot pair, a Boostr_Bot echo of a
// BoostMeBuddy note, and an MSP 2.0 announcement whose amount disagrees with the
// sender's own note. Tags are verbatim except `imeta`, which the decision does
// not read; `content` is cut short for the same reason. The synthetic vectors
// are edits of those events, one field each, so each names what it moves.
//
// A note here is built the way `buildNote` (lib/nostr/discover.ts) builds the
// two fields this reads: `episodeGuids` through the shipping
// `nip73GuidsFromTags`, `amountMsat` from the `amount` tag. A Fountain note has
// no `amount` tag; it adopts its quoted kind:9735's amount at a LATER stage, so
// the vectors pass that amount explicitly, once as unknown and once as known.
import { nip19 } from 'nostr-tools';
import { readFileSync } from 'node:fs';
import { boostEchoIds, dropBoostEchoes, echoSender, ECHO_WINDOW_SEC } from '../lib/nostr/boost-echo.ts';
import { nip73GuidsFromTags } from '../lib/nostr/zap-request.ts';
import { importFreeProblems, explainImportFree } from './import-free.mjs';
import { replayVectors } from './replay-vectors.mjs';

let failures = 0;
const fail = (msg) => { failures += 1; console.error(`  FAIL  ${msg}`); };
const ok = (msg) => console.log(`  ok    ${msg}`);

// ── Wire events ──────────────────────────────────────────────────────────────

// The screenshot. MSP 2.0's bot, 3 s BEFORE the note it echoes.
const MSP_ECHO = {
  id: '2611c310e3ebb8944494686cddd0c7acd5b70416e8f9e02b15fa84a3abbbf86c',
  pubkey: 'ffff6a7af32ea2239cb71548f476eec0dd9ae56673abda536bef5c241276fc3e',
  created_at: 1790979483,
  content: '⚡ Boost ⚡\n\nDear Lord! Let us rave… #nmnu #ohwhatablast #edm #nosta #dancemusic\n\nquincy@fountain.fm boosted 500 sats → The Drake Equation',
  tags: [
    ['i', 'podcast:guid:638e94f7-d20c-4034-af21-0f6947417f44'],
    ['k', 'podcast:guid'],
    ['i', 'podcast:item:guid:704daf75-38d1-42e3-b373-30668c8ee717'],
    ['k', 'podcast:item:guid'],
    ['r', 'https://fountain.fm/track/B3H1Y4yCPnwxY080rVvP?payment=PIeG8d2eTV77SWERtOuG'],
    ['amount', '500000'],
    ['client', 'MSP 2.0'],
    ['app', 'Fountain'],
    ['recipient', 'MSP 2.0'],
    ['sender', 'npub152estz8atgepvet9uxkh8vmrqaqdlw6a20sgjkrcjw37kp4alweq7mcxxg'],
    ['t', 'boostagram'],
    ['t', 'value4value'],
  ],
};

// Quincy's own note, posted by Fountain. No `amount` tag: the 500 sats come
// from the kind:9735 it quotes in its body, which a later stage fetches.
const QUINCY_OWN = {
  id: '433c715f8ffd7e392ca0ec66bc52b574f1c501a78ceb0ef8e5baa769c9abb0ae',
  pubkey: 'a2b30588fd5a32166565e1ad73b3630740dfbb5d53e089587893a3eb06bdfbb2',
  created_at: 1790979486,
  content: 'Dear Lord! Let us rave… #nmnu #ohwhatablast #edm #nosta #dancemusic\n\nhttps://fountain.fm/track/B3H1Y4yCPnwxY080rVvP',
  tags: [
    ['k', 'podcast:item:guid'],
    ['i', 'podcast:item:guid:704daf75-38d1-42e3-b373-30668c8ee717', 'https://fountain.fm/track/B3H1Y4yCPnwxY080rVvP'],
    ['k', 'podcast:guid'],
    ['i', 'podcast:guid:638e94f7-d20c-4034-af21-0f6947417f44', 'https://fountain.fm/album/OHi0sSo5WAWsIoQinBeL'],
    ['t', 'nmnu'], ['t', 'ohwhatablast'], ['t', 'edm'], ['t', 'nosta'], ['t', 'dancemusic'],
  ],
};
const QUINCY_QUOTED_MSAT = 500000; // the quoted kind:9735's 9734 `amount`

// Boostr_Bot echoing a BoostMeBuddy boost, 2 s apart, same amount.
const BOOSTR_ECHO = {
  id: '90f2d1b479cc10311d2624cbc43a97d6306ac1d1680dcff23054c4d62922cd9d',
  pubkey: 'adab4ccd313996520304a5b1ec6c4076bc271bc6a3236702321c5811009d0649',
  created_at: 1790976391,
  content: '⚡ Boost ⚡\n\nI like Reeds idea about listening history in bmb.',
  tags: [
    ['i', 'podcast:item:guid:a91e090d-df36-4195-a8df-8dc6a84536f4'],
    ['k', 'podcast:item:guid'],
    ['i', 'podcast:guid:7c6f7875-2b73-491e-b32c-e2c8d6e91d53'],
    ['k', 'podcast:guid'],
    ['r', 'https://tardbox.com/boost/01M3Z85ZNNE1AAG1HDWGZ6AJX2'],
    ['p', '5cb6d09b8e906a188752965792fec6d2e7c291685cafd442c76a63e559a252c6'],
    ['amount', '777000'],
    ['client', 'Boostr_Bot'],
    ['app', 'BoostMeBuddy', '0.1.0'],
    ['recipient', 'boostr'],
    ['sender', 'npub1u6h46jatm7dwdxtef3lr6nu37wuwjhu98wazgkdv870k7rag9dnqscckn9'],
    ['t', 'boostagram'],
    ['t', 'value4value'],
  ],
};
const BUDDY_OWN = {
  id: '5a607bae7c8b29008c69d6eca866305c797141bd634851be414e9d7add02b1d5',
  pubkey: 'e6af5d4babdf9ae699794c7e3d4f91f3b8e95f853bba2459ac3f9f6f0fa82b66',
  created_at: 1790976393,
  content: '⚡ Boost ⚡\n\nI like Reeds idea about listening history in bmb.',
  tags: [
    ['i', 'podcast:guid:7c6f7875-2b73-491e-b32c-e2c8d6e91d53', 'https://www.boostmebuddy.com/?podcast=7c6f7875-2b73-491e-b32c-e2c8d6e91d53'],
    ['k', 'podcast:guid'],
    ['i', 'podcast:item:guid:a91e090d-df36-4195-a8df-8dc6a84536f4', 'https://www.boostmebuddy.com/?podcast=7c6f7875-2b73-491e-b32c-e2c8d6e91d53&episode=a91e090d-df36-4195-a8df-8dc6a84536f4'],
    ['k', 'podcast:item:guid'],
    ['r', 'https://podcastindex.org/podcast/7968805'],
    ['r', 'https://www.boostmebuddy.com/?podcast=7c6f7875-2b73-491e-b32c-e2c8d6e91d53&episode=a91e090d-df36-4195-a8df-8dc6a84536f4'],
    ['p', '5cb6d09b8e906a188752965792fec6d2e7c291685cafd442c76a63e559a252c6'],
    ['amount', '777000'],
    ['q', '1b112e058b88d7df3dd707d1cb819954e77709a5521f8a5b93c98c5797aff6f4', 'wss://relay.damus.io', '0f49681278b9476945ab7860f2c700974f878ce9b8155ad893463336811739e8'],
    ['client', 'BoostMeBuddy'],
    ['t', 'boostagram'],
    ['t', 'value4value'],
  ],
};

// ChadF's 333-sat boost on Homegrown Hits 153, and an MSP 2.0 announcement
// naming ChadF on the same episode 349 s later — for 25 sats. Two payments.
const CHADF_OWN_333 = {
  id: '36c4d12fda2b64d37fad9d2dfd7b7fa3aa848dc688f5e9a2002b092615c44cfd',
  pubkey: 'f7922a0adb3fa4dda5eecaa62f6f7ee6159f7f55e08036686c68e08382c34788',
  created_at: 1790895846,
  content: '⚡ Boost ⚡\n\nwere LIT\n\nChadF and 33 others boosted 333 sats → Homegrown Hits',
  tags: [
    ['i', 'podcast:guid:ac746d09-7c3b-5bcd-b28a-f12d6456ca8f', 'https://www.boostmebitch.com/?podcast=ac746d09-7c3b-5bcd-b28a-f12d6456ca8f'],
    ['k', 'podcast:guid'],
    ['i', 'podcast:item:guid:homegrownhits-153', 'https://www.boostmebitch.com/?podcast=ac746d09-7c3b-5bcd-b28a-f12d6456ca8f&episode=homegrownhits-153'],
    ['k', 'podcast:item:guid'],
    ['r', 'https://podcastindex.org/podcast/6611624'],
    ['r', 'https://www.boostmebitch.com/?podcast=ac746d09-7c3b-5bcd-b28a-f12d6456ca8f&episode=homegrownhits-153'],
    ['amount', '333000'],
    ['q', '4dfe2831a6dc5474bdb0d9341199e6c0cacbd8063b7390130373754fd8257d42', 'wss://relay.damus.io', '3820f4ff8587747530c7feafe47c1e592e3ce0fd2929b4f907e40714bd26f408'],
    ['client', 'BoostMeBitch'],
    ['t', 'boostagram'],
    ['t', 'value4value'],
  ],
};
const MSP_ECHO_25 = {
  id: 'cdcc11242104f06d5cb2714f5363022fc0f48b3e2bffabd17be3a46000583b49',
  pubkey: 'ffff6a7af32ea2239cb71548f476eec0dd9ae56673abda536bef5c241276fc3e',
  created_at: 1790896195,
  content: '⚡ Boost ⚡\n\nChadF and 33 others boosted 25 sats → Homegrown Hits',
  tags: [
    ['i', 'podcast:item:guid:homegrownhits-153'],
    ['k', 'podcast:item:guid'],
    ['i', 'podcast:guid:e88a4a67-877c-5e03-b8fd-a70cebc821af'],
    ['k', 'podcast:guid'],
    ['i', 'podcast:item:guid:4e197141-6cd6-4366-8fe7-aa6c7c5050e3'],
    ['i', 'podcast:publisher:guid:1a197bac-95ae-53bd-bf6d-40ba8b551088'],
    ['k', 'podcast:publisher:guid'],
    ['r', 'https://tardbox.com/boost/01M3Z7F1KNE35AXJSNB42DFJJ2'],
    ['p', '50a63cca15b16b60d329b92f628c432c8c12689b40fe9d0495eb836b5f2df637'],
    ['amount', '25000'],
    ['client', 'MSP 2.0'],
    ['app', 'BoostMeBitch', '0.1.0'],
    ['recipient', 'MSP 2.0'],
    ['sender', 'npub177fz5zkm87jdmf0we2nz7mm7uc2e7l64uzqrv6rvdrsg8qkrg7yqx0aaq7'],
    ['t', 'boostagram'],
    ['t', 'value4value'],
  ],
};

// ── Building notes the way `buildNote` does, and editing one field ───────────

function note(e, amountMsat) {
  const tagAmount = Number(e.tags.find((t) => t[0] === 'amount')?.[1]);
  return {
    id: e.id,
    pubkey: e.pubkey,
    createdAt: e.created_at,
    amountMsat: amountMsat !== undefined ? amountMsat : (tagAmount > 0 ? tagAmount : null),
    episodeGuids: nip73GuidsFromTags(e.tags).episodeGuids,
    rawEvent: e,
  };
}
/** The same event with a new id and the given edits. */
let serial = 0;
function edit(e, over) {
  serial += 1;
  return { ...e, id: `${'e'.repeat(60)}${String(serial).padStart(4, '0')}`, ...over };
}
const withTag = (tags, name, value) => tags.map((t) => (t[0] === name ? [name, value] : t));
const withItem = (tags, guid) => tags.map((t) => (t[0] === 'i' && t[1].startsWith('podcast:item:guid:')
  ? ['i', `podcast:item:guid:${guid}`] : t));
const withoutItems = (e) => e.tags.filter((t) => !(t[0] === 'i' && t[1].startsWith('podcast:item:guid:')));

const QUINCY_ROOT = note(QUINCY_OWN, null);            // first paint
const QUINCY_FULL = note(QUINCY_OWN, QUINCY_QUOTED_MSAT); // after the quote stage
const MSP = note(MSP_ECHO);
const MSP_TWICE = note(edit(MSP_ECHO, { created_at: MSP_ECHO.created_at + 200 }));
const BOOSTR_OF_QUINCY = note(edit(BOOSTR_ECHO, {
  created_at: QUINCY_OWN.created_at + 40,
  tags: withItem(withTag(withTag(BOOSTR_ECHO.tags, 'sender', MSP_ECHO.tags.find((t) => t[0] === 'sender')[1]),
    'amount', String(QUINCY_QUOTED_MSAT)), '704daf75-38d1-42e3-b373-30668c8ee717'),
}));
const QUINCY_FAR = note(edit(QUINCY_OWN, { created_at: MSP_ECHO.created_at + ECHO_WINDOW_SEC + 1 }), QUINCY_QUOTED_MSAT);
const QUINCY_EDGE = note(edit(QUINCY_OWN, { created_at: MSP_ECHO.created_at + ECHO_WINDOW_SEC }), QUINCY_QUOTED_MSAT);
const QUINCY_OTHER_TRACK = note(edit(QUINCY_OWN, {
  tags: withItem(QUINCY_OWN.tags, '11111111-2222-3333-4444-555555555555'),
}), QUINCY_QUOTED_MSAT);
const MSP_HEX = note(edit(MSP_ECHO, { tags: withTag(MSP_ECHO.tags, 'sender', QUINCY_OWN.pubkey) }));
const MSP_NO_ITEM = note(edit(MSP_ECHO, { tags: withoutItems(MSP_ECHO) }));
// Quincy's note carrying a `sender` tag naming Quincy — and a second of his.
const QUINCY_SELF_NAMED = note(edit(QUINCY_OWN, {
  tags: [...QUINCY_OWN.tags, ['sender', nip19.npubEncode(QUINCY_OWN.pubkey)]],
}), QUINCY_QUOTED_MSAT);
// Another bot announcing the MSP bot as the payer — an echo is never an anchor.
const ECHO_OF_ECHO = note(edit(BOOSTR_ECHO, {
  created_at: MSP_ECHO.created_at + 5,
  tags: withItem(withTag(BOOSTR_ECHO.tags, 'sender', nip19.npubEncode(MSP_ECHO.pubkey)),
    '704daf75-38d1-42e3-b373-30668c8ee717'),
}));

// ── naive(): the obvious version ─────────────────────────────────────────────
// "Hide any note whose `sender` npub authored a note in the same list." No item,
// no window, no amount, no pairing, and it trusts a `sender` naming the author.
function naive(notes) {
  const authors = new Set(notes.map((n) => n.pubkey));
  const hidden = new Set();
  for (const n of notes) {
    const v = n.rawEvent.tags.find((t) => t[0] === 'sender')?.[1];
    if (!v) continue;
    try {
      const d = nip19.decode(v);
      if (d.type === 'npub' && authors.has(d.data)) hidden.add(n.id);
    } catch { /* not an npub */ }
  }
  return hidden;
}

// ── Vectors, as CALLS ────────────────────────────────────────────────────────
const vectors = [
  {
    label: 'the screenshot: MSP 2.0 echo of Quincy’s Fountain note, after the quote stage',
    kind: 'hidden', args: [[MSP, QUINCY_FULL]], expect: [MSP.id], alsoNaive: true,
  },
  {
    label: 'the same pair at FIRST paint, before the Fountain note knows its amount',
    kind: 'hidden', args: [[MSP, QUINCY_ROOT]], expect: [MSP.id], alsoNaive: true,
  },
  {
    label: 'Boostr_Bot echo of a BoostMeBuddy note',
    kind: 'hidden', args: [[note(BOOSTR_ECHO), note(BUDDY_OWN)]], expect: [BOOSTR_ECHO.id], alsoNaive: true,
  },
  {
    label: 'the announcement ALONE stays — the sender’s note is muted, empty or unfetched',
    kind: 'hidden', args: [[MSP]], expect: [], alsoNaive: true,
  },
  {
    label: 'known, DIFFERENT amounts are two payments: 333 sats by ChadF, 25 announced 349 s later',
    kind: 'hidden', args: [[note(CHADF_OWN_333), note(MSP_ECHO_25)]], expect: [],
  },
  {
    label: 'the sender’s note is about ANOTHER track',
    kind: 'hidden', args: [[MSP, QUINCY_OTHER_TRACK]], expect: [],
  },
  {
    label: `the sender’s note is ${ECHO_WINDOW_SEC + 1} s away — outside the window`,
    kind: 'hidden', args: [[MSP, QUINCY_FAR]], expect: [],
  },
  {
    label: `exactly ${ECHO_WINDOW_SEC} s apart still matches`,
    kind: 'hidden', args: [[MSP, QUINCY_EDGE]], expect: [MSP.id], alsoNaive: true,
  },
  {
    label: 'two announcements by ONE bot, one sender note: only the nearer is absorbed',
    kind: 'hidden', args: [[MSP_TWICE, QUINCY_FULL, MSP]], expect: [MSP.id],
  },
  {
    label: 'two DIFFERENT bots announce one boost: both are absorbed',
    kind: 'hidden', args: [[MSP, BOOSTR_OF_QUINCY, QUINCY_FULL]], expect: [MSP.id, BOOSTR_OF_QUINCY.id].sort(), alsoNaive: true,
  },
  {
    label: 'a `sender` naming the note’s OWN author is not an echo',
    kind: 'hidden', args: [[QUINCY_SELF_NAMED, QUINCY_FULL]], expect: [],
  },
  {
    label: 'a hex `sender` counts like an npub',
    kind: 'hidden', args: [[MSP_HEX, QUINCY_FULL]], expect: [MSP_HEX.id],
  },
  {
    label: 'an announcement with no item guid is never hidden',
    kind: 'hidden', args: [[MSP_NO_ITEM, QUINCY_FULL]], expect: [],
  },
  {
    label: 'an announcement is never the anchor for another announcement',
    kind: 'hidden', args: [[ECHO_OF_ECHO, MSP]], expect: [],
  },
];

const ids = (set) => JSON.stringify([...set].sort());
const call = (impl, v) => {
  try {
    return ids(impl === 'real' ? boostEchoIds(...v.args) : naive(...v.args));
  } catch (e) {
    return `threw ${(e && e.message) || e}`;
  }
};

console.log('boostEchoIds — the shipping answer:');
for (const v of vectors) {
  const got = call('real', v);
  if (got !== JSON.stringify(v.expect)) fail(`"${v.label}" — expected ${JSON.stringify(v.expect)}, got ${got}`);
  else ok(v.label);
}

console.log('\nThe replay against naive():');
replayVectors({ vectors, invoke: call, fail });

// ── Properties every vector must hold ────────────────────────────────────────
console.log('\nProperties:');
{
  let orderOk = true;
  for (const v of vectors) {
    const list = v.args[0];
    if (ids(boostEchoIds(list)) !== ids(boostEchoIds([...list].reverse()))) {
      orderOk = false;
      fail(`"${v.label}" — the answer depends on list order`);
    }
  }
  if (orderOk) ok('every vector gives the same answer with its list reversed');

  const list = [MSP_TWICE, QUINCY_FULL, MSP, note(BOOSTR_ECHO), note(BUDDY_OWN)];
  const before = JSON.stringify(list);
  const kept = dropBoostEchoes(list).map((n) => n.id);
  const want = list.map((n) => n.id).filter((id) => id !== MSP.id && id !== BOOSTR_ECHO.id);
  if (JSON.stringify(list) !== before) fail('dropBoostEchoes mutated its input');
  else if (JSON.stringify(kept) !== JSON.stringify(want)) fail(`dropBoostEchoes kept ${JSON.stringify(kept)}, want ${JSON.stringify(want)}`);
  else ok('dropBoostEchoes keeps the order and leaves its input alone');

  if (echoSender(MSP) !== QUINCY_OWN.pubkey) fail('echoSender does not decode the MSP 2.0 bot’s npub to Quincy’s pubkey');
  else ok('echoSender decodes the wire npub to the author of the sender’s note');
  const nsec = nip19.nsecEncode(new Uint8Array(32).fill(7));
  if (echoSender(note(edit(MSP_ECHO, { tags: withTag(MSP_ECHO.tags, 'sender', nsec) }))) !== null) {
    fail('echoSender accepted an nsec as a sender');
  } else ok('echoSender names nobody for an nsec, a note or junk in the tag');
}

// ── The wiring: a pure pin cannot see a surface that stops calling it ────────
console.log('\nWiring:');
{
  const useFeed = readFileSync('lib/nostr/use-feed.ts', 'utf8');
  if (!/export function visibleNotes[\s\S]*?dropBoostEchoes\(/.test(useFeed)) {
    fail('lib/nostr/use-feed.ts: visibleNotes no longer calls dropBoostEchoes');
  } else ok('visibleNotes runs dropBoostEchoes');

  // Every surface that renders <NoteCard>s from a fetched list.
  const surfaces = {
    'components/global-nostr-feed.tsx': /\bvisibleNotes\(/,
    'components/boost-explorer.tsx': /\bvisibleNotes\(/,
    'components/podcast-nostr-feed.tsx': /\buseVisibleNotes\(/,
    'components/episode-nostr-feed.tsx': /\buseVisibleNotes\(/,
  };
  for (const [path, re] of Object.entries(surfaces)) {
    const src = readFileSync(path, 'utf8');
    if (!re.test(src)) fail(`${path} no longer filters through visibleNotes — bot echoes show twice there`);
    else if (/\bnoteHasSubstance\b/.test(src)) fail(`${path} inlines noteHasSubstance again — a second copy of the filter`);
    else ok(`${path} filters through visibleNotes`);
  }
}

// ── The module must stay loadable under plain Node ───────────────────────────
{
  const path = 'lib/nostr/boost-echo.ts';
  const problems = importFreeProblems(path, { allowBare: true });
  if (problems.length) { failures += 1; explainImportFree(path, problems); }
  else ok(`${path} has bare npm imports only`);
}

if (failures) {
  console.error(`\n${failures} boost-echo check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll boost-echo checks passed.');
