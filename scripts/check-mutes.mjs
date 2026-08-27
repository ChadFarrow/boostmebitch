// Pins which cipher the private half of a NIP-51 mute list is read and written
// in, and what counts as a tag array once it is open.
//
// Usage:
//   npm run check:mutes
//
// Run it after ANY edit to lib/nostr/mute-state.ts, and after any change to the
// read/write routing in lib/nostr/mutes.ts.
//
// WHY THIS EARNS A CHECK SCRIPT. `event.content` on a kind:10000 has never had
// one encoding: NIP-51 specified NIP-04, later moved private list items to
// NIP-44, and a few clients leave the tags there in the clear. This app assumed
// NIP-04 for all of it, which is how a Clave sign-in on iOS came back with
// `nip04_decrypt failed: Invalid base64` — a NIP-44 payload has no `?iv=`, so
// the decrypt split on it, got `undefined` for the IV, and threw base64-decoding
// that. Both failure directions here are quiet:
//
//   - GUESS THE CIPHER WRONG on the read and the private half is unreadable
//     forever, which renders as a shorter mute list and nothing else, while a
//     request that cannot succeed is fired at the user's phone every cold start.
//   - GUESS IT WRONG ON THE WRITE and this app re-encodes another client's list
//     into a cipher that client cannot open. The publish succeeds, everything
//     looks right here, and the loss is on someone else's device.
//
// And one vector is a genuine data-loss guard rather than a routing one:
// `parseMuteTags` must answer `null` for a plaintext that is not a tag array,
// because the shipping code returned an empty private list for it WITHOUT
// parking the blob — so the next republish wrote `content: ''` over another
// client's private mutes.
//
// Every assertion is RECORDED as a call and replayed against `naive()` at the
// foot of this file, so the replay is total: a vector cannot be added without
// also being proved to distinguish something. There is one `naive()` PER KIND
// (`classify`, `parse`) and the replay refuses a kind it has no implementation
// for rather than comparing two absences. The must-still-work half is exempted
// ONE VECTOR AT A TIME with `{ alsoNaive: true }` — a legitimate input the wrong
// implementation also handles is a property of that input, never a default.
//
// A new function pinned here needs a recorder AND a naive, or its vectors sit
// green having been compared against nothing.
//
// `--experimental-strip-types` lets this .mjs import the real .ts module. That
// is the whole point: a reimplemented copy stays green while the shipping rule
// drifts. mute-state.ts is importable by plain Node because it has NO imports
// at all — keep it that way.

import { classifyMuteContent, parseMuteTags } from '../lib/nostr/mute-state.ts';
import { importFreeProblems, explainImportFree } from './import-free.mjs';

let failures = 0;
const vectors = [];

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
}

function record(kind, label, args, alsoNaive) {
  vectors.push({ label, kind, args, alsoNaive });
}

function checkClassify(label, content, expected, { alsoNaive = false } = {}) {
  eq(label, classifyMuteContent(content), expected);
  record('classify', label, [content], alsoNaive);
}

function checkParse(label, plaintext, expected, { alsoNaive = false } = {}) {
  eq(label, parseMuteTags(plaintext), expected);
  record('parse', label, [plaintext], alsoNaive);
}

// ---------------------------------------------------------------------------
// REAL ENCODER OUTPUT, not a hand-built string.
//
// Both were produced by nostr-tools 2.19.4 — the library every signer in this
// app ultimately routes through — encrypting the same tag array to a throwaway
// key, and pasted here verbatim:
//
//   const tags = JSON.stringify([['p', '3bf0…459d'], ['word', 'spam']]);
//   nip04.encrypt(sk, pk, tags)
//   nip44.v2.encrypt(tags, nip44.v2.utils.getConversationKey(sk, pk))
//
// A fixture built by concatenating "some base64" + "?iv=" + "some base64"
// would be a restatement of the test's own assumption. These carry the real
// lengths, the real padding and the real alphabet distribution, which is what
// makes the `looksNip44` bounds meaningful.
// ---------------------------------------------------------------------------

const REAL_NIP04 =
  'PZmeaeRPX4bR4CfUCII1ejNbeQCX/zROg9osTUpE3XttO+Rnfh6yOumgW20eywOKr4kgI5eeT7oFLCc5YXSjd1IF'
  + 'oYzv7qJewysS92dcwaISqmVKa1BkX6zq/cUjr7Zi?iv=Ax4vUfn02wf31tmUp7qckQ==';

const REAL_NIP44 =
  'AkdMGfmtBp0MpeSx4C46VatvbsU49dfag8lGgBWWdXiHoO17s/U2qht319NrGg8/N/zGX8C1bUcby06d0t0wCfbl'
  + 'MelhXWP61waOvdXpfpMKeECrwnYJJ2M3Eyev2idTKhZiToFcASa6f/cYdH/+L0BmoUDHNu1Alva8VHQCNJx7ca2b'
  + 'F7vBzmw1TUa8orMP21I2pu6z9S5a6Zg/6uQmBFwxXA==';

const HEX = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';

// ---------------------------------------------------------------------------
console.log('\nthe two real ciphertexts are routed to the right signer method');
// ---------------------------------------------------------------------------
{
  checkClassify('a real NIP-04 payload', REAL_NIP04, 'nip04', { alsoNaive: true });
  checkClassify('a real NIP-44 v2 payload', REAL_NIP44, 'nip44', { alsoNaive: true });

  // The separator is the whole test, and it is exact in this direction: the
  // base64 alphabet holds no `?`, so `?iv=` inside a ciphertext is always the
  // separator and never data.
  // Exempt: the naive version keys on `?iv=` too, so it agrees here. The
  // vector is still worth keeping — it pins that the test is a SEPARATOR test
  // and not a well-formedness test. A malformed NIP-04 payload must still reach
  // nip04.decrypt and fail there, where the failure parks the blob.
  checkClassify('a NIP-04 payload with an empty IV still routes to NIP-04',
    'QUJDRA==?iv=', 'nip04', { alsoNaive: true });
}

// ---------------------------------------------------------------------------
console.log('\nplaintext is recognized BEFORE the ?iv= test — the order is the rule');
// ---------------------------------------------------------------------------
{
  // Exempt: a plaintext list with no `?iv=` in it is the one plaintext case the
  // naive order gets right. It is here as the control the trap below is
  // measured against — without it, "the trap fails naive()" says nothing about
  // whether ordinary plaintext still works.
  checkClassify('an ordinary plaintext tag array',
    JSON.stringify([['p', HEX], ['word', 'spam']]), 'plaintext', { alsoNaive: true });

  // THE TRAP. A mute list can mute the keyword `a?iv=b`, so a plaintext
  // document can contain the exact separator NIP-04 uses. A `?iv=` test placed
  // ahead of the parse sends this to a decrypt — a prompt on the user's phone,
  // for a document that needs no signer at all. This is the vector the naive
  // implementation gets wrong, and it is not hypothetical: `word` mutes hold
  // arbitrary user text.
  checkClassify('a plaintext list whose keyword mute CONTAINS "?iv="',
    JSON.stringify([['word', 'a?iv=b']]), 'plaintext');
  checkClassify('a plaintext list muting the separator itself',
    JSON.stringify([['word', '?iv=']]), 'plaintext');

  // An empty private list is a real state — someone unmuted everyone — and it
  // is plaintext, not unknown. `every` is vacuously true here on purpose.
  checkClassify('an empty tag array', '[]', 'plaintext', { alsoNaive: true });

  // Whitespace around the document is what a hand-edited event looks like.
  // Exempt: the naive version trims before its `[` test too. Kept because the
  // real implementation reaches this through JSON.parse rather than a prefix
  // test, and a future "optimization" to a prefix test would have to keep it.
  checkClassify('leading whitespace does not defeat the parse',
    `  ${JSON.stringify([['p', HEX]])}`, 'plaintext', { alsoNaive: true });
}

// ---------------------------------------------------------------------------
console.log('\na document we only half understand is UNKNOWN, never plaintext');
// ---------------------------------------------------------------------------
{
  // This is the strictness that protects the WRITE path. `["hello"]` is not a
  // tag array; reading it as an empty plaintext list would licence republishing
  // over it, which is the one way classification can destroy data.
  checkClassify('a JSON array of strings is not a tag array', '["hello"]', 'unknown');
  checkClassify('a mixed array with one loose element', '[["p","x"],"loose"]', 'unknown');
  checkClassify('a JSON object', '{"p":"x"}', 'unknown');
  checkClassify('a JSON string', '"just a string"', 'unknown');
  checkClassify('a bare number', '42', 'unknown');

  // A truncated document. Reading it as plaintext would report an empty private
  // list for a list that is not empty.
  checkClassify('a truncated array does not parse and is not plaintext',
    '[["p","3bf0', 'unknown');
}

// ---------------------------------------------------------------------------
console.log('\nnothing to read is its own answer');
// ---------------------------------------------------------------------------
{
  checkClassify('empty content', '', 'unknown');
  checkClassify('whitespace-only content', '   \n ', 'unknown');
}

// ---------------------------------------------------------------------------
console.log('\nthe NIP-44 shape test refuses what it cannot be');
// ---------------------------------------------------------------------------
{
  // A NIP-44 v2 payload is base64 of version(1) || nonce(32) || ct || mac(32),
  // so at least 99 bytes — 132 base64 characters. Anything shorter is not one,
  // whatever else it is.
  checkClassify('base64 far too short to be a NIP-44 payload',
    'QUJDRUZHSA==', 'unknown');
  checkClassify('base64 one character under the 132 floor',
    `A${'B'.repeat(130)}`, 'unknown');

  // The version byte 0x02 has six leading zero bits, so a v2 payload ALWAYS
  // base64-encodes to a leading "A". A payload that does not is some other
  // version, which no signer here can open anyway.
  checkClassify('a long base64 blob that does not start with the v2 version byte',
    `B${REAL_NIP44.slice(1)}`, 'unknown');

  // NIP-44 reserves a leading `#` for a future non-base64 encoding.
  checkClassify('the reserved "#" future-format prefix',
    `#${REAL_NIP44.slice(1)}`, 'unknown');

  // Hex is the shape somebody reaches for when they assume a ciphertext is hex.
  checkClassify('a long hex string is not base64', HEX.repeat(3), 'unknown');

  // Padding that cannot be right. Base64 comes in whole quanta.
  checkClassify('base64 whose length is not a multiple of four',
    `A${'B'.repeat(132)}`, 'unknown');
}

// ---------------------------------------------------------------------------
console.log('\nparseMuteTags — a decrypt that "worked" can still hand back rubbish');
// ---------------------------------------------------------------------------
{
  checkParse('an ordinary tag array',
    JSON.stringify([['p', HEX], ['word', 'spam']]),
    [['p', HEX], ['word', 'spam']], { alsoNaive: true });

  // Exempt: both return []. It is here to pin the DIFFERENCE from the object
  // case below — an empty array is a real state (someone unmuted everyone) and
  // must NOT be folded into the null that parks the blob.
  checkParse('an empty array is an empty list, not a failure', '[]', [], { alsoNaive: true });

  // Carry what you can't read, one level down: a loose element belongs to a
  // writer newer or older than us, and refusing the whole document over it
  // would park a list we otherwise understand.
  // Exempt: the shipping code already filtered loose elements, and that half was
  // right. This vector is what stops the null-for-non-arrays fix below from
  // being over-applied to a document we DO understand.
  checkParse('a loose element is dropped, not fatal',
    '[["p","aa"],"loose",["word","x"]]', [['p', 'aa'], ['word', 'x']], { alsoNaive: true });

  // THE ONE THAT COSTS DATA. A top level that is not an array is what a decrypt
  // against the wrong key looks like. It must be null so the caller PARKS the
  // ciphertext; the shipping code returned an empty list and left the blob
  // unparked, and the next republish wrote `content: ''` over another client's
  // private mutes.
  checkParse('an object is null, so the caller parks the blob', '{"p":"x"}', null);
  checkParse('a string is null', '"hello"', null);
  checkParse('a number is null', '42', null);
  checkParse('null is null', 'null', null);
  checkParse('broken JSON is null', '[["p","aa"]', null);
  checkParse('an empty plaintext is null', '', null);
}

// ---------------------------------------------------------------------------
console.log('\nevery vector fails against the obvious wrong implementation');
// ---------------------------------------------------------------------------
{
  // One naive per recorded kind, and each is the version somebody would
  // actually write — not a strawman. Both pass every ordinary case.
  const naive = {
    // Look for the NIP-04 separator, then guess from the first character. This
    // is the natural order (cheapest test first) and it is exactly backwards:
    // a `word` mute holding "?iv=" is routed to a decrypt, which on a
    // phone-hosted signer is a prompt the user did not ask for and cannot
    // satisfy. It also calls every non-`[` blob NIP-44, so an empty string, a
    // truncated payload and a hex string all become decrypt attempts.
    classify: (content) => {
      if (content.includes('?iv=')) return 'nip04';
      return content.trim().startsWith('[') ? 'plaintext' : 'nip44';
    },
    // What lib/nostr/mutes.ts shipped: parse, keep it if it is an array, and
    // fall back to an empty list. The empty list is the bug — it is
    // indistinguishable from "there were no private mutes", so the caller never
    // parks the blob and the next republish destroys it.
    parse: (plaintext) => {
      try {
        const p = JSON.parse(plaintext);
        return Array.isArray(p) ? p.filter((t) => Array.isArray(t)) : [];
      } catch {
        return [];
      }
    },
  };

  const real = {
    classify: classifyMuteContent,
    parse: parseMuteTags,
  };

  const call = (impl, v) => {
    const fn = (impl === 'real' ? real : naive)[v.kind];
    // A vector whose kind has no implementation on either side would compare
    // equal and pass silently — the exact hole this replay exists to close.
    if (!fn) return `no ${impl} implementation for kind "${v.kind}"`;
    try {
      return JSON.stringify(fn(...v.args));
      // A wrong implementation is allowed to throw where the real one returns.
      // That still counts as differing — it is the loudest way to be wrong.
    } catch (e) {
      return `threw ${(e && e.message) || e}`;
    }
  };

  let exempt = 0;
  for (const v of vectors) {
    const differs = call('real', v) !== call('naive', v);
    if (v.alsoNaive) {
      exempt += 1;
      console.log(`  ok    "${v.label}" is must-still-work — naive() may get it right`);
      continue;
    }
    if (differs) {
      console.log(`  ok    naive() gets "${v.label}" wrong`);
      continue;
    }
    failures += 1;
    console.error(`  FAIL  "${v.label}" passes against naive() too — the vector proves nothing.`);
    console.error('          Either it is a must-still-work input (mark it { alsoNaive: true })');
    console.error('          or it does not exercise anything the real module adds.');
  }
  console.log(`  ${vectors.length} vector(s) replayed, ${exempt} exempt as must-still-work`);
}

// ---------------------------------------------------------------------------
console.log('\nmute-state.ts stays loadable under plain Node');
// ---------------------------------------------------------------------------
{
  // The arrangement this whole script depends on: it imports the REAL module,
  // so the module must keep resolving under `node --experimental-strip-types`.
  // See scripts/import-free.mjs for why a type-only relative import counts —
  // and note that this is also why MuteCipher lives in mute-state.ts beside
  // MuteListState rather than in a leaf of its own.
  const problems = importFreeProblems('lib/nostr/mute-state.ts');
  if (problems.length) { explainImportFree('lib/nostr/mute-state.ts', problems); failures += problems.length; }
  else console.log('  ok    lib/nostr/mute-state.ts has no imports that plain Node cannot resolve');
}

if (failures) {
  console.error(`\n${failures} mute check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll mute checks passed.');
