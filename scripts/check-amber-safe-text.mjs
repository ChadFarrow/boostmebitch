// Pins the encoding that lets an NWC connection string reach Amber intact —
// lib/nostr/amber-safe-text.ts and `payloadSurvivesAmber` in
// lib/nostr/amber-callback-url.ts.
//
// Usage:
//   npm run check:ambersafe
//
// Run it after ANY edit to either module, or to `publishEncryptedNwc` /
// `fetchEncryptedNwc` in lib/nostr/wallet-backup.ts.
//
// ## Why this earns a check script
//
// Amber URL-decodes the WHOLE `nostrsigner:` URI and only then splits it, on
// `?` first. NIP-47 writes an NWC connection string as
// `nostr+walletconnect://<pubkey>?relay=…&secret=…`, so the `?` is not an
// occasional user-typed character there — it is in EVERY connection string
// there has ever been. The plaintext therefore truncated at `?relay=` and Amber
// answered "Invalid request. Amber received a malformed nostrsigner request."
// to every NWC backup ever attempted from an Android device.
//
// Both directions of getting this wrong are silent:
//
//   - Encode too little (the pre-fix state, which is the naive implementation
//     below) and every Amber backup fails with a message that reads as "Amber
//     didn't come back" — the symptom docs/signers.md explicitly warns is NOT
//     evidence about the callback code. Nothing on this side can tell them apart.
//   - Decode too little — drop the legacy branch, or accept a prefix without
//     validating the body — and a backup that IS on relays reads back as "No
//     backup found on Nostr for this account". The user's stored spending
//     credential is intact and unreachable, and the app says it never existed.
//
// ## What the vectors actually assert
//
// Not "there is no `?` in the output today". The property is stronger, and it
// is what makes the encoding survive the same class of parser bug next time:
// the encoded text uses ONLY characters `encodeURIComponent` leaves alone, so
//
//     encodeURIComponent(encodeAmberSafe(x)) === encodeAmberSafe(x)
//
// — no encode/decode pass anywhere in the chain, ours or Amber's, can turn it
// into a delimiter. `fixedPoint` is that vector kind.
//
// ## Every vector is proved against the version that shipped
//
// Vectors are recorded as CALLS (`{ kind, args }`) and the replay walks the
// whole list, so a vector cannot be added without also being compared against
// the obvious wrong implementation. That implementation is not a strawman: it
// is literally what shipped — no encoding at all, `JSON.stringify({uri})`
// handed straight to `nip44.encrypt`. A vector the naive version also satisfies
// is exempted ONE AT A TIME with `alsoNaive: true`, which marks it a
// must-still-work property rather than a hole.
//
// `--experimental-strip-types` lets this .mjs import the real .ts modules. That
// is the whole point: a reimplemented copy stays green while the shipping rule
// drifts. Both modules are importable by plain Node because they have NO
// imports at all — keep it that way.

import {
  AMBER_SAFE_PREFIX,
  encodeAmberSafe,
  decodeAmberSafe,
} from '../lib/nostr/amber-safe-text.ts';
import { payloadSurvivesAmber } from '../lib/nostr/amber-callback-url.ts';
import { importFreeProblems, explainImportFree } from './import-free.mjs';

let failures = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}\n          expected ${e}\n          got      ${a}`);
  }
}

// ---------------------------------------------------------------------------
// Real wire shapes. The connection strings are the format NIP-47 mandates and
// the format Alby / Mutiny / AlbyHub actually emit; only the hex is fabricated,
// because a real one is a live spending credential. What matters about them is
// structural and is not fabricated: `?relay=` and then `&secret=`.
// ---------------------------------------------------------------------------
const NWC_ALBY = 'nostr+walletconnect://b889ff5b1513b641e2a139f661a661364979c5beee91842f8f0ef42ab558e9d4'
  + '?relay=wss://relay.getalby.com/v1'
  + '&secret=71a8c14c1728459b9f0a9e6cbbd3e0a9f0e0d3a1b2c3d4e5f60718293a4b5c6d';
// Two relays and a lud16 carrying a `+` — the shapes that get past an encoder
// thinking about suffixes and not about delimiters.
const NWC_MULTI = 'nostr+walletconnect://c0ffee00000000000000000000000000000000000000000000000000deadbeef'
  + '?relay=wss://relay.damus.io&relay=wss://nos.lol'
  + '&secret=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
  + '&lud16=chad+boosts@getalby.com';
// The single-slash form `connect()` deliberately accepts, so it must back up too.
const NWC_SINGLE_SLASH = 'nostr+walletconnect:b889ff5b?relay=wss://relay.getalby.com/v1&secret=71a8c14c';
// A NIP-44 v2 ciphertext is standard base64, and standard base64 has never
// contained a `?`. That is exactly why "Restore from Nostr" was measured
// working on the same device where every backup failed — the read path puts a
// ciphertext in the payload and the write path put a connection string there.
// Pinned so nobody "fixes" the direction that needs nothing.
const NIP44_CIPHERTEXT = 'AgOoQTgv1KLCFmJi7ZOEjMBXwR8YrO+dJqUsm3zK4cxIe0/vP2Hn9dGtLsvQwWyRb3'
  + 'nKpX8mZ1aTcVuI7dEoFgHjY4sN2QrLxBvMwPzAaC0dEfGh==';
// Every ASCII punctuation character, so no vector class rides on the specific
// symbols an NWC URI happens to use.
const ALL_PUNCTUATION = ' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

const json = (uri) => JSON.stringify({ uri });

// ---------------------------------------------------------------------------
// One vector table, replayed in full below. Nothing is asserted outside it
// except the import-free scan.
//
//   survives    — payloadSurvivesAmber(encode(x)): does Amber get the whole thing
//   fixedPoint  — encodeURIComponent(encode(x)) === encode(x)
//   containsAny — does encode(x) contain any character from a given set
//   roundTrip   — decode(encode(x)) === x
//   decode      — decodeAmberSafe(<literal>), for legacy and junk inputs
//   raw         — payloadSurvivesAmber(<literal>), no encoding involved
// ---------------------------------------------------------------------------
const VECTORS = [
  // -- the bug, stated three ways -------------------------------------------
  { label: 'an Alby connection string survives Amber once encoded', kind: 'survives', args: [json(NWC_ALBY)], expect: true },
  { label: 'a two-relay connection string with a lud16 survives', kind: 'survives', args: [json(NWC_MULTI)], expect: true },
  { label: 'the single-slash form connect() accepts survives too', kind: 'survives', args: [json(NWC_SINGLE_SLASH)], expect: true },
  {
    // ISOLATING VECTOR. Every case above is also satisfied by an encoder that
    // merely strips `?`. This one fails unless the output is unreserved-only,
    // which is the property that survives a parser splitting on something else.
    label: 'the encoded text is a fixed point of percent-encoding',
    kind: 'fixedPoint', args: [json(NWC_ALBY)], expect: true,
  },
  { label: 'fixed point holds for the multi-relay string too', kind: 'fixedPoint', args: [json(NWC_MULTI)], expect: true },
  { label: 'fixed point holds for every ASCII punctuation character', kind: 'fixedPoint', args: [ALL_PUNCTUATION], expect: true },
  {
    // `+` is unreserved to nobody: encodeURIComponent escapes it, and a
    // form-decoder turns a bare one into a space. Neither may touch the output.
    label: 'no delimiter reaches the wire unencoded',
    kind: 'containsAny', args: [json(NWC_MULTI), '+/=?&%#;'], expect: false,
  },

  // -- what the encoding must not lose --------------------------------------
  { label: 'an Alby connection string round-trips exactly', kind: 'roundTrip', args: [json(NWC_ALBY)], expect: true, alsoNaive: true },
  { label: 'a multi-relay connection string round-trips exactly', kind: 'roundTrip', args: [json(NWC_MULTI)], expect: true, alsoNaive: true },
  { label: 'non-ASCII round-trips (UTF-8 bytes, not char codes)', kind: 'roundTrip', args: ['Mütton & Mead — track 3 ⚡'], expect: true, alsoNaive: true },
  { label: 'every ASCII punctuation character round-trips', kind: 'roundTrip', args: [ALL_PUNCTUATION], expect: true, alsoNaive: true },
  { label: 'the empty string round-trips', kind: 'roundTrip', args: [''], expect: true, alsoNaive: true },
  // Base64 pads at 3-byte boundaries and the padding is stripped, so all three
  // remainders have to decode. One length class silently broken is a backup
  // that fails for some users and not others.
  { label: 'a 1-byte body round-trips (padding restored)', kind: 'roundTrip', args: ['a'], expect: true, alsoNaive: true },
  { label: 'a 2-byte body round-trips', kind: 'roundTrip', args: ['ab'], expect: true, alsoNaive: true },
  { label: 'a 3-byte body round-trips', kind: 'roundTrip', args: ['abc'], expect: true, alsoNaive: true },

  // -- reading: legacy backups, and junk ------------------------------------
  {
    // The one that costs a user their stored credential if it regresses. Every
    // backup written before this encoding shipped is bare JSON.
    label: 'a legacy bare-JSON backup is reported as not-this-format',
    kind: 'decode', args: [json(NWC_ALBY)], expect: null,
  },
  { label: 'a bare connection string is not-this-format', kind: 'decode', args: [NWC_ALBY], expect: null },
  { label: 'the empty plaintext is not-this-format', kind: 'decode', args: [''], expect: null },
  { label: 'the prefix alone decodes to the empty string, not null', kind: 'decode', args: [AMBER_SAFE_PREFIX], expect: '' },
  { label: 'a prefixed body outside base64url is refused', kind: 'decode', args: [`${AMBER_SAFE_PREFIX}not base64!`], expect: null },
  { label: 'a prefixed body using base64 (not -url) characters is refused', kind: 'decode', args: [`${AMBER_SAFE_PREFIX}ab+/cd`], expect: null },
  { label: 'a prefixed body of an impossible length is refused', kind: 'decode', args: [`${AMBER_SAFE_PREFIX}abcde`], expect: null },
  { label: 'a prefixed body that is not valid UTF-8 is refused', kind: 'decode', args: [`${AMBER_SAFE_PREFIX}-_8`], expect: null },
  { label: 'a near-miss prefix is not-this-format', kind: 'decode', args: ['bmb2.YWJj'], expect: null },

  // -- the predicate itself, on payloads nobody encodes ---------------------
  {
    label: 'a NIP-44 ciphertext already survives, so the read path needs nothing',
    kind: 'raw', args: [NIP44_CIPHERTEXT], expect: true, alsoNaive: true,
  },
  { label: 'a raw connection string does NOT survive', kind: 'raw', args: [json(NWC_ALBY)], expect: false, alsoNaive: true },
  // The measured pair from Amber 6.3.0 and 6.5.2, in shipping-code form.
  { label: '"does this work. yes" survives', kind: 'raw', args: ['{"content":"does this work. yes"}'], expect: true, alsoNaive: true },
  { label: '"does this work? yes" does not', kind: 'raw', args: ['{"content":"does this work? yes"}'], expect: false, alsoNaive: true },
  { label: 'an & alone is fine — it separates parameters, not the payload', kind: 'raw', args: ['{"content":"Mutton & Mead"}'], expect: true, alsoNaive: true },
];

// ---------------------------------------------------------------------------
// The obvious wrong implementation: what shipped. No encoding at all — the
// plaintext went to `nip44.encrypt` as-is, and the reader parsed it as-is.
// ---------------------------------------------------------------------------
const naiveEncode = (text) => text;
const naiveDecode = (text) => text;

function call(impl, v) {
  const real = impl === 'real';
  const enc = real ? encodeAmberSafe : naiveEncode;
  const dec = real ? decodeAmberSafe : naiveDecode;
  switch (v.kind) {
    case 'survives':
      return payloadSurvivesAmber(enc(...v.args));
    case 'fixedPoint': {
      const out = enc(...v.args);
      return encodeURIComponent(out) === out;
    }
    case 'containsAny': {
      const [text, chars] = v.args;
      const out = enc(text);
      return [...chars].some((c) => out.includes(c));
    }
    case 'roundTrip': {
      const [text] = v.args;
      return dec(enc(text)) === text;
    }
    case 'decode':
      return dec(...v.args);
    case 'raw':
      return payloadSurvivesAmber(...v.args);
    default:
      throw new Error(`unknown vector kind ${v.kind}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nvectors');
// ---------------------------------------------------------------------------
for (const v of VECTORS) check(v.label, call('real', v), v.expect);

// ---------------------------------------------------------------------------
console.log('\nevery vector is proved against the implementation that shipped');
// ---------------------------------------------------------------------------
{
  // TOTAL replay: the loop walks the whole table, so a vector cannot be added
  // without being compared. `alsoNaive` exempts one input at a time and is
  // never the default — see check-assetlinks.mjs, where a hand-written second
  // list left a whole section compared against nothing while its header claimed
  // otherwise.
  let vacuous = 0;
  for (const v of VECTORS) {
    let naiveResult;
    try { naiveResult = call('naive', v); } catch { naiveResult = '<threw>'; }
    const differs = JSON.stringify(naiveResult) !== JSON.stringify(v.expect);
    if (v.alsoNaive) {
      if (differs) {
        failures++;
        console.error(`  FAIL  "${v.label}" is marked alsoNaive but the naive version FAILS it`
          + '\n          drop the flag — it is a discriminating vector, not a must-still-work one');
      } else {
        console.log(`  ok    ${v.label} — must-still-work, naive agrees by design`);
      }
    } else if (differs) {
      console.log(`  ok    ${v.label} — naive gives ${JSON.stringify(naiveResult)}`);
    } else {
      vacuous++;
      failures++;
      console.error(`  FAIL  "${v.label}" passes against the implementation that SHIPPED BROKEN`
        + '\n          it proves nothing. Sharpen it, or mark it { alsoNaive: true }'
        + '\n          if it is deliberately a must-still-work property.');
    }
  }
  if (!vacuous) console.log(`  ok    ${VECTORS.length} vectors, none vacuous`);
}

// ---------------------------------------------------------------------------
console.log('\nboth modules stay loadable under plain Node');
// ---------------------------------------------------------------------------
for (const mod of ['lib/nostr/amber-safe-text.ts', 'lib/nostr/amber-callback-url.ts']) {
  const problems = importFreeProblems(mod);
  if (problems.length) { explainImportFree(mod, problems); failures += problems.length; }
  else console.log(`  ok    ${mod} has no imports that plain Node cannot resolve`);
}

if (failures) {
  console.error(`\n${failures} amber-safe-text check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll amber-safe-text checks passed.');
