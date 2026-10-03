// Pins `deletedNoteIds` and `withoutDeleted` (lib/nostr/note-deletions.ts) —
// which notes a feed takes off screen because their author published a NIP-09
// kind:5 naming them.
//
// Usage:
//   npm run check:deletions
//
// WHY THIS EARNS A CHECK SCRIPT. The feed used to read no kind:5 at all, so a
// deleted note stayed on screen wherever a relay ignored NIP-09, and stayed in
// the `bmb:feed:*` cache and the union in `useNostrFeed` for good. Reading the
// deletions fixes that and opens the opposite failure, which is the one nobody
// reports because nothing on screen says a card is missing: a kind:5 is a
// signed event ANYONE can publish naming ANY id, and a relay that ignores
// NIP-09 hands it to every reader. Honoring it from a stranger lets one key
// take any boost off every feed. That is `naive()` below.
//
// THE FIXTURES ARE TWO REAL kind:5 EVENTS, verbatim, read off relay.damus.io,
// nos.lol and relay.primal.net on 2026-10-03 by asking for the kind:5 events of
// the authors of 300 recent `podcast:item:guid` notes:
//
//   BOT_BATCH — adab4ccd…, a boost-announcement bot, deleting 40 of its own
//               kind:1 boost notes in ONE event ("MSP 2.0 boost notes now come
//               from MSP 2.0's own account…"). The many-ids shape.
//   AMETHYST  — e6871cca…, one kind:1, written by Amethyst with `p`, `k` and a
//               `client` tag. The one-id shape most clients write.
//
// None of the three relays still served any of the 41 targets — they honor
// NIP-09 — so the notes below are built in the targets' shape: the real id, the
// real author. That is all `deletedNoteIds` reads.

import { deletedNoteIds, withoutDeleted, NOTE_DELETION_KIND } from '../lib/nostr/note-deletions.ts';
import { importFreeProblems, explainImportFree } from './import-free.mjs';
import { replayVectors } from './replay-vectors.mjs';

let failures = 0;
const fail = (msg) => { failures += 1; console.error(`  FAIL  ${msg}`); };
const ok = (msg) => console.log(`  ok    ${msg}`);

const BOT_BATCH = {"content":"MSP 2.0 boost notes now come from MSP 2.0's own account, and only for artists who agreed.","created_at":1790958894,"id":"76b49a46d37d22603ee231c9a2dcd611269e974e37e6ec3dc8b21e4f46c9665a","kind":5,"pubkey":"adab4ccd313996520304a5b1ec6c4076bc271bc6a3236702321c5811009d0649","sig":"83f8730f67ba5097aa3212323ad8b2ef577a43efeb3b3bff198790828b4394b3841419a1db66bdca3abdfbc168df00323b2256c8ec4e48f2b332769716277d1a","tags":[["e","b1d0392543ac2f9d8693eecfcabc5b44d4fe454c9bd88b0aa85e9cc25f6d4d4d"],["e","63a42fffca8e15409f1d41ce9ad38b200dbff9c9e911ecda24eace2a65315b82"],["e","003e234d2fb16fa6f288c90b33d5cafdb633e60161135a9af0145cec0b3c871f"],["e","7c30acec68045f70f4456a3b46e8d6f07b8898476dcb30a4df8c9620d7acafad"],["e","8e5d1205eeda3301969e9b76e18e5b9c80c8e25c108c53dde753611dcb74da36"],["e","8ea5ead97a686ccc099f3852f668c97fe5a72b68255142ea136805ff16ee6f85"],["e","d8c4d76eb0378133bbf7714c44c67148781d13acedf31df38d9f3582d5e08c46"],["e","19966929a4cb9cd2fd35a0f42e75f39d6c5d75b6ec20712253000ecbc99db624"],["e","d79f7c9109c5e9e3b67a9ced473df7eb949c5f254506b7ec822df38f3a5436b2"],["e","93a04be70e0cd69cdb373c3145858bb256a981edf30c84ae2011143c2a5aa717"],["e","d99a95e451d8cfd10829cbd306fb9eac34b9be5ceccebd4869927a165f9bdee5"],["e","1b7fdb17d00968ec445b0bfcab76781c9665ecfebbd37fdeb20d456e13a13b51"],["e","b38076ac75cfb25baa6bca355722f3beeae6550130928829f644341de2c6d426"],["e","79b9a2d5f55ad8735722c039a6b073387024f56aa04e10d433671919096a7b6f"],["e","b651660190e99c5622c8d9510284d20de4dbce9c5f9efd70465b6a7de40b0cc6"],["e","4f9bf5138fca5f93a0d89461920a2f88814aa51f33450015343908f338ed25f0"],["e","7ddaeef36d1ebd8db2c7e4ddaadf7d383c5e2e574de9504fa8e8060d442a3a84"],["e","0d11212852478410db8504fa59f7496a36f0f5f1dd33d715ac4cc464a3015f14"],["e","8f65c9377cf8152a75d421f5da497fde12cc356cbda08755afda025436d9aa43"],["e","5bc8a86d77994710218e17d74d1a9d373726bdfc70b5d7293344b5274b214f52"],["e","ff3df7fff9877e6cc12648c9074d4365e5040b3c7b2aa1c52272795617b62537"],["e","ece04da5dd26602cf2dbc77ff84695d2ad7072da31b1ae71838a97027fa417ae"],["e","e2ec72a299c8bcb49d71349e6b89101221a001237e782954f01d9412c9244b39"],["e","5100ec4d345dfc4b07b76ca7babe4b840a0d1d0d740ef16d812e60b7f214a45e"],["e","b9a96b060cffb7cc3f04fc61d4e82c20e6fafb1c8bba34fd2d8aa43e9d513f86"],["e","13f5f1ca6e0e35ef180758634acf5529fea872704d32c86da11723c4708aeefc"],["e","2ebc57b4d5245a835c062deab81b69d2b225eb1b97481939bf08966be0a71c6b"],["e","1910a86022744020976bf36e308e38d7865528cab54ac4a3cf0e7ebe6b0837fd"],["e","7eac4fec46c07cbf3ed2e397ed9514c363f2df571619c949c9bf14f833570b08"],["e","3d833757ac887779e9ad1ca626ca45e4c82f6c8e5eb8553a08d7f865a4f6025f"],["e","5735339f9f0c2a3a40620bfb8bd51983a38bf4c9beb964d573b0cc35667711d8"],["e","1a5047f52252f1683d9cae9067356f4175a388336b759945a7fcaa5fd4e391fa"],["e","e347f5682dc9cffe53b4a3d7ccc68d4a8e1177ce8eb9dcc06a89d51b02bfa267"],["e","b5ae6bc7608ecba97442aad57aa149e75c4794ed161fc5dff983a59570c67569"],["e","c12a06a52b7713cb584b8281bd1e58468d7256f179ee911841e8c54a889b5f43"],["e","40a8bf4dc3567f2f7eafffe58445516fbfee35238b196e353ba8e86f0b1918bb"],["e","16a3c376fb5ecdf36ed84a97917f7ccf6faa1aa4c90eef57bfb4e3ac884312bf"],["e","71b2a5f4fd9f24a2aec6a15944a12da28eb6b5a2190f515e8e3e0802140beabc"],["e","07f49b53d9d4c09f851cba3b05a351c458a92f539afa28de7d77f9182dac3297"],["e","053a145a84cd1f9a6fbfd5c3460ea2440c563a987d013fd088760eb8d68d776b"],["k","1"]]};
const AMETHYST = {"content":"","created_at":1790498754,"id":"36c1b8763881077ed6066da14fb8cb21d28d0c04132dfd95ee7faa23639e3248","kind":5,"pubkey":"e6871cca1f2e3b45d49c8a3aa0fb5d8b3dd777a040195fb0b71cb4248bbb7dcd","sig":"4e19c48a2698e440ddd0e1ed43740f9c4186268adf9b29a5f8b6849ce75f9295af9fffb5a2932c59b2e6f691cdc1158b46e3aef08821f8566a31ea26982ddcc6","tags":[["e","3c14ae18bfd30cac4e90ae6612fb6b033e451951239648a0ca628bac9c5c847d"],["p","e6871cca1f2e3b45d49c8a3aa0fb5d8b3dd777a040195fb0b71cb4248bbb7dcd"],["k","1"],["client","Amethyst"]]};

const BOT = BOT_BATCH.pubkey;
const AME = AMETHYST.pubkey;
const STRANGER = '5'.repeat(64);
const OTHER = '7'.repeat(64);
const eIds = (ev) => ev.tags.filter((t) => t[0] === 'e').map((t) => t[1]);

const note = (id, pubkey, replies = []) => ({ id, pubkey, replies });
const BOT_NOTE = note(eIds(BOT_BATCH)[0], BOT);
const BOT_NOTE_LAST = note(eIds(BOT_BATCH)[39], BOT);
const AME_NOTE = note(eIds(AMETHYST)[0], AME);
const KEPT = note('a'.repeat(64), OTHER);

// The same wire bytes re-signed by somebody else: a stranger's kind:5 naming
// the bot's notes. The signature is not what `deletedNoteIds` checks — every
// event reaching it was verified by nostr-tools — so only the pubkey changes.
const STRANGER_BATCH = { ...BOT_BATCH, pubkey: STRANGER };
// The tags of a deletion on a kind that is NOT a deletion.
const NOT_A_DELETION = { ...AMETHYST, kind: 1 };

// ── naive(): the obvious version ──────────────────────────────────────────
// "Hide any note a kind:5 names", without asking who wrote it; and a prune
// that walks the top level only.
function naiveDeleted(deletions, notes) {
  const asked = new Set();
  for (const d of deletions) {
    if (d.kind !== NOTE_DELETION_KIND) continue;
    for (const t of d.tags) if (t[0] === 'e') asked.add(t[1]);
  }
  return new Set(notes.filter((n) => asked.has(n.id)).map((n) => n.id));
}
function naivePrune(notes, deleted) {
  return notes.filter((n) => !deleted.has(n.id));
}

const vectors = [
  // deletedNoteIds
  {
    label: "a real 40-id batch deletes the author's own notes, first and last",
    kind: 'deleted', args: [[BOT_BATCH], [BOT_NOTE, BOT_NOTE_LAST, KEPT]],
    expect: [BOT_NOTE.id, BOT_NOTE_LAST.id].sort(), alsoNaive: true,
  },
  {
    label: "a real one-id Amethyst deletion deletes its author's note",
    kind: 'deleted', args: [[AMETHYST], [AME_NOTE, KEPT]], expect: [AME_NOTE.id], alsoNaive: true,
  },
  {
    label: 'a kind:5 from a STRANGER naming the notes deletes nothing',
    kind: 'deleted', args: [[STRANGER_BATCH], [BOT_NOTE, BOT_NOTE_LAST]], expect: [],
  },
  {
    label: "one author's kind:5 cannot reach another author's note with the same id in the list",
    kind: 'deleted', args: [[AMETHYST], [note(AME_NOTE.id, OTHER)]], expect: [],
  },
  {
    label: 'the author and a stranger both naming it: the author still counts',
    kind: 'deleted', args: [[STRANGER_BATCH, BOT_BATCH], [BOT_NOTE]], expect: [BOT_NOTE.id], alsoNaive: true,
  },
  {
    label: 'deletion tags on a kind that is not 5 delete nothing',
    kind: 'deleted', args: [[NOT_A_DELETION], [AME_NOTE]], expect: [], alsoNaive: true,
  },
  {
    label: 'no deletions: nothing is deleted',
    kind: 'deleted', args: [[], [BOT_NOTE, AME_NOTE]], expect: [], alsoNaive: true,
  },
  // withoutDeleted
  {
    label: 'a deleted REPLY leaves the thread, and its own replies with it',
    kind: 'prune',
    args: [[note('r1', OTHER, [note('c1', BOT, [note('g1', OTHER)]), note('c2', OTHER)])], ['c1']],
    expect: ['r1', ['c2']],
  },
  {
    label: 'a deleted top-level note leaves the feed',
    kind: 'prune', args: [[KEPT, BOT_NOTE], [BOT_NOTE.id]], expect: [KEPT.id], alsoNaive: true,
  },
];

// A prune result as nested ids, so two trees compare as strings.
const shape = (notes) => notes.flatMap((n) => (n.replies.length ? [n.id, shape(n.replies)] : [n.id]));
const run = (impl, v) => {
  if (v.kind === 'deleted') {
    const fn = impl === 'real' ? deletedNoteIds : naiveDeleted;
    return [...fn(...v.args)].sort();
  }
  const fn = impl === 'real' ? withoutDeleted : naivePrune;
  return shape(fn(v.args[0], new Set(v.args[1])));
};
const call = (impl, v) => {
  try { return JSON.stringify(run(impl, v)); } catch (e) { return `threw ${(e && e.message) || e}`; }
};

console.log('deletedNoteIds / withoutDeleted — the shipping answer:');
for (const v of vectors) {
  const got = call('real', v);
  if (got !== JSON.stringify(v.expect)) fail(`"${v.label}" — expected ${JSON.stringify(v.expect)}, got ${got}`);
  else ok(v.label);
}

console.log('\nThe replay against naive():');
replayVectors({ vectors, invoke: call, fail });

// ── withoutDeleted keeps identity where nothing changed ─────────────────────
// `<NoteCard>` is memoized; a fresh object per note re-renders the whole feed.
{
  const feed = [KEPT, note('r', OTHER, [note('c', OTHER)])];
  if (withoutDeleted(feed, new Set()) !== feed) fail('an empty deleted set returns a new array');
  else if (withoutDeleted(feed, new Set(['nope'])) !== feed) fail('a deleted set naming nothing on screen returns a new array');
  else {
    const out = withoutDeleted(feed, new Set([KEPT.id]));
    if (out[0] !== feed[1]) fail('an untouched thread was copied instead of reused');
    else ok('withoutDeleted reuses every array and note it did not change');
  }
}

// ── The module must stay loadable under plain Node ───────────────────────────
{
  const path = 'lib/nostr/note-deletions.ts';
  const problems = importFreeProblems(path);
  if (problems.length) { failures += 1; explainImportFree(path, problems); }
  else ok(`${path} has no imports`);
}

if (failures) {
  console.error(`\n${failures} note-deletion check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll note-deletion checks passed.');
