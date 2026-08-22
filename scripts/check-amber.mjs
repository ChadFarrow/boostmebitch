// Pins the `nostrsigner:` wire format and the fragment Amber returns a result
// in — lib/nostr/amber-callback-url.ts.
//
// Usage:
//   npm run check:amber
//
// Run it after ANY edit to lib/nostr/amber-callback-url.ts or lib/nostr/amber.ts.
//
// ## Why this earns a check script
//
// This feature has already failed twice, in production, for two DIFFERENT
// reasons, and both times the broken version looked right in review:
//
//   1. A callbackUrl with no terminator. Amber appends its result verbatim with
//      no param name of its own, so `…/amber-callback?id=X` came back as
//      `…/amber-callback?id=X<result>` and the page could parse nothing.
//   2. Commit 9a9330f "fixed" that by terminating with `&event=` — which is the
//      literal example in the NIP-55 text, and which ALSO cannot work, because
//      Amber URL-decodes the whole URI and splits it on `?` and then `&`. The
//      callback URL is truncated at the first of either. That commit's message
//      says the bug is fixed. It was not, and nothing caught it for months.
//
// Both failures are silent: the signer approves, the user comes back, and
// nothing happens. There is no error to read. So the rule "the callback URL may
// contain no `?` and no `&`, and must end with the separator" is an assertion in
// shipping code (`assertCallbackUrlSafe`) and a vector here.
//
// ## The fixtures are real wire data
//
// CLAUDE.md: build a fixture from the WIRE, never from the struct you parse it
// into. The two AMBER_WIRE_* strings below were captured verbatim from
// `adb logcat` (`capturedLink=…`) on 2026-08-21, from Amber 6.3.0 on a Pixel 6
// (Android 17, Brave default, no Chrome), driven from a real browser tab by the
// same hidden-anchor click lib/nostr/amber.ts uses. They are what Amber
// actually sent, not what we think it sends.
//
// That matters most for ENCODE_REPLAY. The synthetic stress vectors need to
// escape a string the way Android's `Uri.encode` does, and a hand-rolled
// encoder that merely looks right would make every one of them vacuous. So the
// replay is not asserted from documentation — it is proved to be a left-inverse
// of Amber's real output on the captured signed event, and only then used.
//
// ## What is NOT covered
//
// Whether a browser delivers the fragment to the page, and whether the TWA or a
// browser tab wins the callback, are device facts. Both were measured by hand
// (docs/signers.md) and neither is reproducible here.
//
// `--experimental-strip-types` lets this .mjs import the real .ts module. That
// is the whole point: a reimplemented copy stays green while the shipping rule
// drifts. amber-callback-url.ts is importable by plain Node because it has NO
// imports at all — keep it that way.

import {
  AMBER_CALLBACK_PATH,
  AMBER_RESULT_SEPARATOR,
  assertCallbackUrlSafe,
  buildAmberCallbackUrl,
  buildSignerUrl,
  looksLikeAmberResult,
  newAmberRequestId,
  parseAmberCallback,
} from '../lib/nostr/amber-callback-url.ts';
import { importFreeProblems, explainImportFree, valueImportPath } from './import-free.mjs';

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
// Captured from the device. Do not regenerate these from our own code.
// ---------------------------------------------------------------------------

// get_public_key. Amber appended a bare 64-hex pubkey — nothing in it needed
// escaping, which is exactly why it is a weak fixture on its own and why the
// signed event below is here too.
const AMBER_WIRE_PUBKEY =
  'http://127.0.0.1:8099/cb#r=0123456789abcdef0123456789abcdef;event=f7922a0adb3fa4dda5eecaa62f6f7ee6159f7f55e08036686c68e08382c34788';

// sign_event. This is the one that carries the shapes nobody thinks to invent:
// braces, quotes, colons, commas, brackets and spaces, all percent-escaped by
// Android's `Uri.encode`, with `.` left literal.
const AMBER_WIRE_EVENT =
  'http://127.0.0.1:8099/cb#r=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;event=%7B%22id%22%3A%229aafbd01b4471789da08568e266a51f5015ee44192764aa56a61671ddb49acef%22%2C%22pubkey%22%3A%22f7922a0adb3fa4dda5eecaa62f6f7ee6159f7f55e08036686c68e08382c34788%22%2C%22created_at%22%3A1735689600%2C%22kind%22%3A1%2C%22tags%22%3A%5B%5D%2C%22content%22%3A%22does%20this%20work.%20yes%22%2C%22sig%22%3A%225f98dcf833d71177d08cf6261fcf1e0d99d505a1850bbbc0a194996d85dd0e1ebb01c9a4baa31fed869c65ef185ef1a84b2ec76dbc0bd9b5de6bbd7b245a35c8%22%7D';

// The truncation itself, also captured. This is what Amber did with a callback
// URL of `http://127.0.0.1:8099/cb?rid=SPIKE123#result=` — everything from the
// `?` onward is gone and the result is welded onto the path. It is the reason
// `assertCallbackUrlSafe` exists.
const AMBER_WIRE_TRUNCATED =
  'http://127.0.0.1:8099/cbf7922a0adb3fa4dda5eecaa62f6f7ee6159f7f55e08036686c68e08382c34788';

const fragmentOf = (url) => url.slice(url.indexOf('#'));

// ---------------------------------------------------------------------------
console.log('\nthe encode replay matches what Amber really sent');
// ---------------------------------------------------------------------------
{
  // Android's Uri.encode(String) "Leaves letters, numbers, and unreserved
  // characters (_-!.~'()*) intact" — the same set encodeURIComponent leaves
  // alone. That claim is documentation. Below it is checked against the wire:
  // decode Amber's real output, re-encode it, and require the bytes back.
  // Locate the separator in the captured string rather than assuming it. If
  // AMBER_RESULT_SEPARATOR is ever changed back to something Amber truncates,
  // this is the first thing that notices, and it has to say so in words rather
  // than throwing out of a JSON.parse three lines later.
  const at = AMBER_WIRE_EVENT.indexOf(AMBER_RESULT_SEPARATOR);
  check(`the captured callback actually uses "${AMBER_RESULT_SEPARATOR}" as its separator`, at >= 0, true);
  const tail = at >= 0 ? AMBER_WIRE_EVENT.slice(at + AMBER_RESULT_SEPARATOR.length) : '';
  let decoded = '';
  try { decoded = decodeURIComponent(tail); } catch { /* reported below */ }
  check('encodeURIComponent round-trips Amber 6.3.0 output byte-for-byte', encodeURIComponent(decoded), tail);
  let content = null;
  try { content = JSON.parse(decoded).content; } catch { /* reported below */ }
  check('and the decode yields the event we asked it to sign', content, 'does this work. yes');

  // The truncation, stated as a fact about Amber rather than a vector about us:
  // with a `?` in the callback URL there is no fragment left at all, so there is
  // nothing for any parser to find. This is why assertCallbackUrlSafe has to run
  // BEFORE dispatch — after the fact the information is simply gone.
  check('a ?-bearing callback came back with no fragment whatsoever', AMBER_WIRE_TRUNCATED.includes('#'), false);
  check('and the raw result was welded onto the path instead', AMBER_WIRE_TRUNCATED.endsWith('c34788'), true);
}
const ENCODE_REPLAY = encodeURIComponent;

// ---------------------------------------------------------------------------
console.log('\nassertCallbackUrlSafe rejects what Amber would damage');
// ---------------------------------------------------------------------------

const threw = (fn) => { try { fn(); return false; } catch { return true; } };

// ---------------------------------------------------------------------------
// One vector table, replayed in full against naive() below. Nothing is checked
// outside it except the two encode-replay assertions above (which have no naive
// counterpart — they are about Amber, not about us) and the import-free scan.
// ---------------------------------------------------------------------------
const VECTORS = [
  // -- assertCallbackUrlSafe ------------------------------------------------
  {
    label: '9a9330f\'s own output: a callback terminated with &event=',
    fn: 'assertSafe',
    args: ['https://www.boostmebitch.com/amber-callback?id=X&event='],
    expect: true,
  },
  {
    label: 'the NIP-55 text\'s own example, which is also unusable',
    fn: 'assertSafe',
    args: ['https://example.com/?event='],
    expect: true,
  },
  {
    label: 'a query-only callback (the shape measured being truncated)',
    fn: 'assertSafe',
    args: ['http://127.0.0.1:8099/cb?rid=SPIKE123#result='],
    expect: true,
  },
  {
    label: 'a fragment callback with a stray & still refused',
    fn: 'assertSafe',
    args: ['https://www.boostmebitch.com/amber-callback#r=0123456789abcdef0123456789abcdef&event='],
    expect: true,
  },
  {
    label: 'a fragment callback with no terminator refused',
    fn: 'assertSafe',
    args: ['https://www.boostmebitch.com/amber-callback#r=0123456789abcdef0123456789abcdef'],
    expect: true,
  },
  {
    // ISOLATING VECTOR. Every other `?` case above is ALSO caught by the `&`
    // rule or the terminator rule, so deleting the `?` guard left the suite
    // green — verified by mutation. This URL has a `?`, no `&`, and a correct
    // terminator, so only the `?` guard can reject it. Same below for `&`.
    label: 'a `?` alone is fatal, even with a correct terminator',
    fn: 'assertSafe',
    args: ['https://www.boostmebitch.com/amber-callback?x#r=0123456789abcdef0123456789abcdef;event='],
    expect: true,
  },
  {
    label: 'an `&` alone is fatal, even with a correct terminator',
    fn: 'assertSafe',
    args: ['https://www.boostmebitch.com/amber-callback#r=0123456789abcdef0123456789abcdef&x;event='],
    expect: true,
  },
  {
    // MUST STILL WORK: over-blocking here means the feature never dispatches.
    label: 'the real callback URL is accepted',
    fn: 'assertSafe',
    args: ['https://www.boostmebitch.com/amber-callback#r=0123456789abcdef0123456789abcdef;event='],
    expect: false,
    mustStillWork: true,
  },

  // -- buildAmberCallbackUrl ------------------------------------------------
  {
    label: 'builds origin + path + fragment, terminator last',
    fn: 'buildCallback',
    args: ['https://www.boostmebitch.com', '0123456789abcdef0123456789abcdef'],
    expect: 'https://www.boostmebitch.com/amber-callback#r=0123456789abcdef0123456789abcdef;event=',
  },

  // -- parseAmberCallback ---------------------------------------------------
  {
    // MUST STILL WORK: a real callback has to parse. A sloppy parser gets this
    // right too, and that is the point — the value of the real one is in the
    // rejections below, not in the happy path.
    label: 'WIRE: a real get_public_key fragment parses',
    fn: 'parse',
    args: [fragmentOf(AMBER_WIRE_PUBKEY)],
    expect: {
      rid: '0123456789abcdef0123456789abcdef',
      raw: 'f7922a0adb3fa4dda5eecaa62f6f7ee6159f7f55e08036686c68e08382c34788',
    },
    mustStillWork: true,
  },
  {
    label: 'WIRE: a real signed event fragment parses and decodes',
    fn: 'parseContent',
    args: [fragmentOf(AMBER_WIRE_EVENT)],
    expect: 'does this work. yes',
    mustStillWork: true,
  },
  {
    label: 'a result containing the separator survives (Uri.encode escapes it)',
    fn: 'parseRaw',
    args: [`#r=0123456789abcdef0123456789abcdef;event=${ENCODE_REPLAY('a;event=b')}`],
    expect: 'a;event=b',
    mustStillWork: true,
  },
  {
    label: 'a result containing # ? & % + survives',
    fn: 'parseRaw',
    args: [`#r=0123456789abcdef0123456789abcdef;event=${ENCODE_REPLAY('#?&%+ end')}`],
    expect: '#?&%+ end',
    mustStillWork: true,
  },
  {
    label: 'a multi-byte result survives (measured live with an em-dash)',
    fn: 'parseRaw',
    args: [`#r=0123456789abcdef0123456789abcdef;event=${ENCODE_REPLAY('Mutton & Mead — track 3 🎸')}`],
    expect: 'Mutton & Mead — track 3 🎸',
    mustStillWork: true,
  },
  { label: 'no leading #r= is refused', fn: 'parse', args: ['#event=abc'], expect: null },
  // Degenerate: no implementation returns anything for an empty string. Kept
  // because /amber-callback is reachable with no fragment at all — a user
  // bookmarking it, or a forged navigation — and the page must not crash.
  { label: 'an empty fragment is refused', fn: 'parse', args: [''], expect: null, degenerate: true },
  { label: 'a short rid is refused', fn: 'parse', args: ['#r=0123;event=abc'], expect: null },
  { label: 'a non-hex rid is refused', fn: 'parse', args: [`#r=${'z'.repeat(32)};event=abc`], expect: null },
  { label: 'an uppercase rid is refused', fn: 'parse', args: [`#r=${'A'.repeat(32)};event=abc`], expect: null },
  // Degenerate against both wrong impls, since neither finds a separator
  // either. Pins the contract that the separator is required.
  { label: 'no separator is refused', fn: 'parse', args: [`#r=${'0'.repeat(32)}abc`], expect: null, degenerate: true },
  { label: 'an empty result is refused', fn: 'parse', args: [`#r=${'0'.repeat(32)};event=`], expect: null },
  { label: 'a whitespace-only result is refused', fn: 'parse', args: [`#r=${'0'.repeat(32)};event=%20%20`], expect: null },
  { label: 'a malformed percent sequence is refused, not thrown', fn: 'parse', args: [`#r=${'0'.repeat(32)};event=%ZZ`], expect: null },

  // -- buildSignerUrl -------------------------------------------------------
  {
    // MUST STILL WORK, and load-bearing: with no callbackUrl these bytes must
    // stay identical to what shipped, because every request that keeps the
    // clipboard return still goes out this way.
    label: 'no callbackUrl selects the clipboard return, byte layout unchanged',
    fn: 'buildSigner',
    args: [{ type: 'get_public_key' }],
    expect: 'nostrsigner:?compressionType=none&returnType=signature&type=get_public_key',
    mustStillWork: true,
  },
  {
    label: 'a callbackUrl is appended last and percent-encoded',
    fn: 'buildSigner',
    args: [
      { type: 'sign_event', payload: '{"kind":1}', returnType: 'event' },
      'https://www.boostmebitch.com/amber-callback#r=0123456789abcdef0123456789abcdef;event=',
    ],
    expect:
      'nostrsigner:%7B%22kind%22%3A1%7D?compressionType=none&returnType=event&type=sign_event'
      + '&callbackUrl=https%3A%2F%2Fwww.boostmebitch.com%2Famber-callback%23r%3D0123456789abcdef0123456789abcdef%3Bevent%3D',
  },
  {
    label: 'a peer pubkey rides before the callbackUrl',
    fn: 'buildSigner',
    args: [
      { type: 'nip04_decrypt', payload: 'ct', pubkey: 'ff00' },
      'https://x.test/amber-callback#r=0123456789abcdef0123456789abcdef;event=',
    ],
    expect:
      'nostrsigner:ct?compressionType=none&returnType=signature&type=nip04_decrypt&pubkey=ff00'
      + '&callbackUrl=https%3A%2F%2Fx.test%2Famber-callback%23r%3D0123456789abcdef0123456789abcdef%3Bevent%3D',
  },
  {
    label: 'buildSignerUrl refuses an unusable callbackUrl rather than dispatching it',
    fn: 'buildSignerThrows',
    args: [{ type: 'get_public_key' }, 'https://x.test/amber-callback?event='],
    expect: true,
  },

  // -- looksLikeAmberResult -------------------------------------------------
  { label: 'a hex pubkey is a plausible get_public_key', fn: 'looks', args: [AMBER_WIRE_PUBKEY.slice(-64), 'get_public_key'], expect: true, mustStillWork: true },
  { label: 'an npub is a plausible get_public_key', fn: 'looks', args: ['npub1abc', 'get_public_key'], expect: true, mustStillWork: true },
  { label: 'a signed event is not a plausible pubkey', fn: 'looks', args: ['{"sig":"aa"}', 'get_public_key'], expect: false },
  { label: 'a copied URL is not a plausible pubkey', fn: 'looks', args: ['https://example.com', 'get_public_key'], expect: false },
  { label: 'a signed event is a plausible sign_event', fn: 'looks', args: ['{"sig":"aa"}', 'sign_event'], expect: true, mustStillWork: true },
  { label: 'an unsigned event is not', fn: 'looks', args: ['{"kind":1}', 'sign_event'], expect: false },
  { label: 'malformed JSON is not', fn: 'looks', args: ['{oops', 'sign_event'], expect: false },
  // Degenerate: the wrong impl is "accept anything non-empty", so it agrees
  // here by construction. Pins that an empty clipboard never resolves a request.
  { label: 'an empty string is never plausible', fn: 'looks', args: ['', 'nip04_decrypt'], expect: false, degenerate: true },
  { label: 'any non-empty ciphertext is accepted', fn: 'looks', args: ['?iv=', 'nip04_decrypt'], expect: true, mustStillWork: true },
];

// ---------------------------------------------------------------------------
// The obvious wrong implementation. Not a strawman: `naiveBuildCallback` and
// `naiveParse` are the `?event=` shape from 9a9330f, and `naiveAssertSafe` is
// the state of the world before this file existed — no check at all.
// ---------------------------------------------------------------------------
function naiveBuildCallback(origin, rid) {
  return `${origin}${AMBER_CALLBACK_PATH}?rid=${rid}&event=`;
}
//
// Parsing gets TWO wrong implementations, because there are two genuinely
// tempting ones and each is blind where the other sees:
//
//   naiveParseLegacy — believes the result arrives as a query parameter, which
//     is the 9a9330f world and what anyone reading the NIP-55 text would write.
//   naiveParseSloppy — has the format right and validates nothing: no rid
//     shape, no empty-result check, no guard on a bad percent sequence. This is
//     the version you get by writing the happy path and stopping, and it is the
//     one a reviewer would wave through.
//
// A vector counts as discriminating if it differs from EITHER. Requiring it to
// beat only one would let the rejection vectors — which are where a parser's
// value actually is — coast on the legacy parser being wrong about everything.
function naiveParseLegacy(hash) {
  const q = hash.startsWith('#') ? hash.slice(1) : hash;
  const got = new URLSearchParams(q).get('event');
  return got ? { rid: new URLSearchParams(q).get('rid') ?? '', raw: got } : null;
}
function naiveParseSloppy(hash) {
  if (!hash.startsWith('#r=')) return null;
  const body = hash.slice(3);
  const i = body.indexOf(AMBER_RESULT_SEPARATOR);
  if (i < 0) return null;
  return { rid: body.slice(0, i), raw: decodeURIComponent(body.slice(i + AMBER_RESULT_SEPARATOR.length)) };
}
const NAIVE_PARSERS = [naiveParseLegacy, naiveParseSloppy];
function naiveAssertSafe() { /* the pre-fix state: nothing was checked */ }
function naiveBuildSignerUrl(opts, callbackUrl) {
  let url = `nostrsigner:${encodeURIComponent(opts.payload ?? '')}`;
  url += `?compressionType=none`;
  url += `&returnType=${opts.returnType ?? 'signature'}`;
  url += `&type=${opts.type}`;
  if (opts.pubkey) url += `&pubkey=${opts.pubkey}`;
  if (callbackUrl) url += `&callbackUrl=${callbackUrl}`; // unencoded, unchecked
  return url;
}
const naiveLooks = (text) => text.length > 0;

// `parser` selects which parse implementation to exercise; the other cases
// ignore it and branch on `real`.
function call(impl, v, parser) {
  const real = impl === 'real';
  const p = real ? parseAmberCallback : parser;
  switch (v.fn) {
    case 'assertSafe':
      return threw(() => (real ? assertCallbackUrlSafe : naiveAssertSafe)(...v.args));
    case 'buildCallback':
      return (real ? buildAmberCallbackUrl : naiveBuildCallback)(...v.args);
    case 'parse':
      return p(...v.args);
    case 'parseRaw':
      return (p(...v.args) ?? {}).raw ?? null;
    case 'parseContent': {
      const got = p(...v.args);
      if (!got) return null;
      try { return JSON.parse(got.raw).content; } catch { return null; }
    }
    case 'buildSigner':
      return (real ? buildSignerUrl : naiveBuildSignerUrl)(...v.args);
    case 'buildSignerThrows':
      return threw(() => (real ? buildSignerUrl : naiveBuildSignerUrl)(...v.args));
    case 'looks':
      return (real ? looksLikeAmberResult : naiveLooks)(...v.args);
    default:
      throw new Error(`unknown fn ${v.fn}`);
  }
}

const IS_PARSE = (fn) => fn === 'parse' || fn === 'parseRaw' || fn === 'parseContent';

// ---------------------------------------------------------------------------
console.log('\nvectors');
// ---------------------------------------------------------------------------
for (const v of VECTORS) check(v.label, call('real', v, parseAmberCallback), v.expect);

// ---------------------------------------------------------------------------
console.log('\nevery vector is replayed against naive() — a vector that passes');
console.log('against the wrong implementation proves nothing');
// ---------------------------------------------------------------------------
{
  // TOTAL, deliberately. check-assetlinks.mjs shipped with a hand-picked list
  // and a header claiming totality, which was the defect rather than the
  // design. Exemptions are per-vector, named `mustStillWork`, and are only for
  // legitimate inputs where getting the same answer as naive() is correct.
  const impls = (v) => (IS_PARSE(v.fn) ? NAIVE_PARSERS : [null]);
  for (const v of VECTORS) {
    const expected = JSON.stringify(call('real', v, parseAmberCallback));
    const differs = impls(v).some((parser) => {
      try {
        return JSON.stringify(call('naive', v, parser)) !== expected;
      } catch {
        return true; // a naive impl throwing where the real one answers is a difference
      }
    });
    if (v.mustStillWork) {
      console.log(`  ok    "${v.label}" is must-still-work — a wrong impl may agree`);
    } else if (v.degenerate) {
      // Stated rather than hidden. These pin the contract; they do not
      // discriminate, because no plausible implementation gets them wrong.
      // Counting them as proof is what check-assetlinks.mjs did, and that was
      // the defect rather than the design.
      console.log(`  --    "${v.label}" is degenerate — it pins the contract and proves nothing`);
    } else if (differs) {
      console.log(`  ok    a wrong impl gets "${v.label}" wrong`);
    } else {
      failures++;
      console.error(`  FAIL  "${v.label}" passes against every wrong impl too — the vector proves nothing.`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\nrequest ids');
// ---------------------------------------------------------------------------
{
  const ids = new Set();
  let shaped = true;
  for (let i = 0; i < 500; i++) {
    const id = newAmberRequestId();
    if (!/^[0-9a-f]{32}$/.test(id)) shaped = false;
    ids.add(id);
  }
  check('every id is 32 lowercase hex characters', shaped, true);
  // 128 bits: a collision in 500 draws would mean the generator is not random,
  // which is the whole security property — the id is what makes a forged
  // navigation to /amber-callback inert.
  check('500 ids are distinct', ids.size, 500);
  check('buildAmberCallbackUrl refuses an id it did not make', threw(() => buildAmberCallbackUrl('https://x.test', 'nope')), true);
}

// ---------------------------------------------------------------------------
console.log('\nlib/storage.ts stays out of lib/nostr/\'s import graph');
// ---------------------------------------------------------------------------
{
  // amber.ts imports lib/storage.ts to park a pending request across the reload
  // a callbackUrl causes. That is legal ONLY while storage.ts has no value
  // import back into lib/nostr/ — otherwise this closes:
  //
  //   storage.ts -> nostr/auth.ts -> nostr/signer.ts -> nostr/amber.ts -> storage.ts
  //
  // which does not fail the build. It surfaces as a module-init order bug: an
  // export that plainly exists reads as undefined at a call site that looks
  // correct. Asserted here rather than remembered.
  for (const target of ['lib/nostr/amber.ts', 'lib/nostr/auth.ts', 'lib/nostr/signer.ts']) {
    const cycle = valueImportPath('lib/storage.ts', target);
    if (cycle) {
      failures++;
      console.error(`  FAIL  lib/storage.ts has a value-import path back into ${target}:`);
      for (const step of cycle) console.error(`          ${step}`);
      console.error('\n        Push whatever both sides need DOWN into an import-free leaf'
        + '\n        (lib/nostr/profile-metadata.ts is why this passes today), rather'
        + '\n        than importing sideways.\n');
    } else {
      console.log(`  ok    no value-import path lib/storage.ts -> ${target}`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\namber-callback-url.ts stays loadable under plain Node');
// ---------------------------------------------------------------------------
{
  const problems = importFreeProblems('lib/nostr/amber-callback-url.ts');
  if (problems.length) { explainImportFree('lib/nostr/amber-callback-url.ts', problems); failures += problems.length; }
  else console.log('  ok    lib/nostr/amber-callback-url.ts has no imports that plain Node cannot resolve');
}

if (failures) {
  console.error(`\n${failures} amber check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll amber checks passed.');
