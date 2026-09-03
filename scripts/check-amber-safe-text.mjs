// Pins the two encodings that let a payload reach Amber intact —
// lib/nostr/amber-safe-text.ts (`encodeAmberSafe` for an app-private plaintext,
// `escapeJsonForAmber` for JSON another app reads) and `payloadSurvivesAmber`
// in lib/nostr/amber-callback-url.ts.
//
// Usage:
//   npm run check:ambersafe
//
// Run it after ANY edit to either module, to `AmberSigner.signEvent` in
// lib/nostr/amber.ts, or to `publishEncryptedNwc` / `fetchEncryptedNwc` in
// lib/nostr/wallet-backup.ts.
//
// ## The second bug, 2026-09-03: EVERY boost note failed the same way
//
// `formatContent` (lib/nostr/boost-notes.ts) writes two URLs into every note —
// the in-app link `…/?podcast=<guid>` and the banner `…/api/og/boost.png?art=…`
// — so every `sign_event` for a boost note carried a `?` and Amber answered
// "Invalid request" on the phone's screen. `encodeAmberSafe` cannot fix that:
// a `bmb1.` prefix inside a kind:1 is a note no client can read. The escape
// that works is JSON's own — `?` written as `\u003f` — because Amber splits the
// URI on `?` and THEN parses the JSON (IntentUtils.kt: `decoded.split("?")`,
// then `AmberEvent.fromJson`). To the parser `\u003f` is `?`; to the splitter
// it is nothing. The `escape*` vectors below pin both halves: no `?` reaches
// the wire, and the parsed value is unchanged.
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
  escapeJsonForAmber,
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

// The kind:1 template `publishBoostNote` builds, in the shape `formatContent`
// and `boostBannerUrl` write it: both URLs carry a `?`, and the `i` tag names an
// item guid that is itself a permalink with a query string — the three places a
// `?` reaches an event without anyone typing one. The message ends in one too.
const BOOST_NOTE_TEMPLATE = JSON.stringify({
  kind: 1,
  created_at: 1756900000,
  tags: [
    ['i', 'podcast:guid:917393e3-1b1e-5cef-ace4-edaa54e1f810'],
    ['k', 'podcast:guid'],
    ['i', 'podcast:item:guid:https://example.com/episodes/146?src=rss'],
    ['k', 'podcast:item:guid'],
    ['amount', '1000000'],
    ['client', 'BoostMeBitch'],
  ],
  content: '⚡ Boost ⚡\n\nis this the one?\n\nChadF boosted 1000 sats → Homegrown Hits\n'
    + '📻 Episode 146\n\nhttps://pod.link/1234\n'
    + 'https://www.boostmebitch.com/?podcast=917393e3-1b1e-5cef-ace4-edaa54e1f810&episode=https%3A%2F%2Fexample.com%2Fepisodes%2F146%3Fsrc%3Drss\n\n'
    + 'https://www.boostmebitch.com/api/og/boost.png?art=https%3A%2F%2Fexample.com%2Fart.jpg&title=Homegrown+Hits&ep=Episode+146&sats=1000',
});
// A `?` right after a backslash: JSON.stringify writes the backslash as `\\`,
// so the escape must land AFTER the pair, not inside it.
const BACKSLASH_THEN_QUESTION = JSON.stringify({ content: 'C:\\?\\ok' });
// The six literal characters `\u003f` typed by a user. JSON.stringify writes
// them as `\\u003f`; the escape must not mistake that for its own output.
const LITERAL_ESCAPE_TEXT = JSON.stringify({ content: 'type \\u003f to ask' });

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
//   escapeSurvives — payloadSurvivesAmber(escapeJsonForAmber(json))
//   escapeLossless — JSON.parse(escapeJsonForAmber(json)) deep-equals JSON.parse(json)
//   escapeBytes    — escapeJsonForAmber(json), the literal output
// ---------------------------------------------------------------------------
const VECTORS = [
  // -- the boost note, and every other `?` that reaches an event ------------
  { label: 'a boost note template survives Amber once escaped', kind: 'escapeSurvives', args: [BOOST_NOTE_TEMPLATE], expect: true },
  { label: 'and parses back to the identical event', kind: 'escapeLossless', args: [BOOST_NOTE_TEMPLATE], expect: true, alsoNaive: true },
  { label: '"does this work? yes" — the measured failure — survives once escaped', kind: 'escapeSurvives', args: ['{"content":"does this work? yes"}'], expect: true },
  { label: 'the escape is the JSON one, byte for byte', kind: 'escapeBytes', args: ['{"content":"does this work? yes"}'], expect: '{"content":"does this work\\u003f yes"}' },
  { label: 'a ? after an escaped backslash survives', kind: 'escapeSurvives', args: [BACKSLASH_THEN_QUESTION], expect: true },
  { label: 'and is still the same string after the backslash', kind: 'escapeLossless', args: [BACKSLASH_THEN_QUESTION], expect: true, alsoNaive: true },
  { label: 'a typed literal \\u003f is left as the user typed it', kind: 'escapeLossless', args: [LITERAL_ESCAPE_TEXT], expect: true, alsoNaive: true },
  // Must-still-work: an event with no `?` is not touched at all, so the bytes
  // Amber has signed for every other note are exactly what it signed before.
  { label: 'an event with no ? is byte-identical', kind: 'escapeBytes', args: ['{"kind":1,"tags":[],"content":"does this work. yes"}'], expect: '{"kind":1,"tags":[],"content":"does this work. yes"}', alsoNaive: true },
  { label: 'a ? inside a tag value is escaped too', kind: 'escapeSurvives', args: [JSON.stringify([['i', 'podcast:item:guid:https://e.com/p?id=1']])], expect: true },

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
// The second bug's shipped state: `JSON.stringify(template)` handed to Amber as-is.
const naiveEscape = (text) => text;

const deepEqualJson = (a, b) => JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));

function call(impl, v) {
  const real = impl === 'real';
  const enc = real ? encodeAmberSafe : naiveEncode;
  const dec = real ? decodeAmberSafe : naiveDecode;
  const esc = real ? escapeJsonForAmber : naiveEscape;
  switch (v.kind) {
    case 'escapeSurvives':
      return payloadSurvivesAmber(esc(...v.args));
    case 'escapeLossless':
      return deepEqualJson(esc(...v.args), v.args[0]);
    case 'escapeBytes':
      return esc(...v.args);
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
