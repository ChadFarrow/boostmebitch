// Pins `isApprovalPending` — the predicate that decides whether a NIP-46
// rejection may be RE-ISSUED.
//
// Usage:
//   npm run check:nip46error
//
// Run it after ANY edit to lib/nostr/nip46-errors.ts.
//
// WHY THIS EARNS A CHECK SCRIPT. Clave (iOS) answers a request with
// `permission denied` FIRST and delivers the real result on the same request id
// once the user approves. nostr-tools 2.19.4 settles on the first response, so
// without a retry every signature after sign-in fails — the boost note, the
// favorites publish, the mute publish. `lib/nostr/bunker.ts` re-issues on this
// predicate, and both directions of getting it wrong are invisible from the
// screen:
//
//   under-match   a Clave user's publishes keep failing, and the failure is
//                 indistinguishable from a signer that refused. One phrasing
//                 dropped from the list is enough.
//   OVER-match    a DIFFERENT signer's terminal "no" — nsec.app, Amber as a
//                 bunker — becomes a 60-second wait for an approval that is
//                 never coming, while the user watches a spinner. This is the
//                 expensive direction and it is why the must-still-work half
//                 below is not decoration.
//
// THE DISCRIMINATOR IS THE TYPE, NOT THE TEXT, and that is the part that will
// be "simplified" away. nostr-tools 2.19.4 (`lib/esm/nip46.js`) rejects with the
// signer's error STRING, unwrapped; every other rejection on that path is an
// `Error` — `bunker.ts`'s own `withTimeout`, "this signer is not open anymore",
// and the `AggregateError` from `Promise.any(pool.publish(...))`. An `Error`
// whose message happens to read "permission denied" is a LOCAL fault wearing
// the remote answer's words, and retrying it papers over a real disconnect. The
// `naive()` control at the bottom is exactly that mistake — a text-only matcher
// — and is asserted to disagree with the shipping predicate.
//
// `--experimental-strip-types` lets this .mjs import the real .ts module.
// `bunker.ts` itself can never be checked this way (it imports `nostr-tools`
// and touches browser globals), which is the whole reason the predicate was
// split into an import-free leaf. Keep that leaf import-free.

import {
  APPROVAL_PENDING_PATTERNS,
  isApprovalPending,
  isRequestTooLarge,
  nip46RequestBytes,
  nip46RequestFits,
  NIP46_MAX_REQUEST_BYTES,
} from '../lib/nostr/nip46-errors.ts';
import { readFileSync } from 'node:fs';
import { importFreeProblems, explainImportFree } from './import-free.mjs';

let failures = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ok    ${label}`);
    return true;
  }
  failures += 1;
  console.error(`  FAIL  ${label}\n          expected ${expected}\n          actual   ${actual}`);
  return false;
}

function section(name) {
  console.log(`\n${name}`);
}

// The naive version: match the TEXT of anything, however it arrived. It is what
// you write if you read only the regex list and not the type test above it.
function naive(e) {
  const text = typeof e === 'string' ? e : (e && e.message) || '';
  return APPROVAL_PENDING_PATTERNS.some((re) => re.test(text));
}

// Every vector is recorded as a CALL so the naive replay below cannot silently
// skip one. `alsoNaive: true` marks the vectors the naive version is allowed to
// agree on — see the replay section.
const vectors = [];
function vec(label, input, expected, opts = {}) {
  vectors.push({ label, input, expected, ...opts });
  check(label, isApprovalPending(input), expected);
}

// ---------------------------------------------------------------------------
section('A bare string off the wire, in a phrasing that means "still asking"');
// ---------------------------------------------------------------------------
{
  // Five from Clave's own reference web client (DocNR/clave-casa,
  // src/lib/signer.ts). Not invented here.
  vec('permission denied', 'permission denied', true, { alsoNaive: true });
  vec('permission not granted', 'permission not granted', true, { alsoNaive: true });
  vec('not authorized', 'not authorized', true, { alsoNaive: true });
  vec('awaiting approval', 'awaiting approval', true, { alsoNaive: true });
  vec('queued for approval', 'queued for approval', true, { alsoNaive: true });

  // THE SIXTH CAME OFF A PHONE, NOT OUT OF THAT FILE — which is why it is
  // called out rather than appended. Clave answered a pairing's
  // `get_public_key` with exactly this, and none of the five above matched, so
  // the sign-in reported "no permission" while Clave's Recent Activity showed
  // the same call succeeding. A vendor's list is where this starts, not where
  // it ends: when a signer produces a phrasing that is missing, add the
  // observed string — never loosen a pattern above into a token that would
  // have swept it up along with everything else.
  vec('no permission', 'no permission', true, { alsoNaive: true });
  vec('no permission, as a sentence',
    'get_public_key: no permission for this client', true, { alsoNaive: true });

  // Case and surrounding prose must not matter — a signer writes a sentence,
  // not a token.
  vec('case-insensitive', 'Permission Denied', true, { alsoNaive: true });
  vec('embedded in a sentence',
    'request 7f3a: permission denied by user policy', true, { alsoNaive: true });
  vec('surrounded by whitespace', '  permission denied\n', true, { alsoNaive: true });
}

// ---------------------------------------------------------------------------
section('MUST STILL WORK: a rejection that is not an answer is never retried');
// ---------------------------------------------------------------------------
{
  // THE vector of this script. An Error is a LOCAL fault — our timeout, a dead
  // transport, a publish that reached nobody. Retrying it hides a real
  // disconnect behind a minute of waiting, and the reconnect banner never
  // appears. The message is deliberately the exact phrase that fires above:
  // only the TYPE separates them.
  vec('an Error whose message reads "permission denied"',
    new Error('permission denied'), false);
  vec('bunker.ts\'s own timeout',
    new Error('Bunker sign_event timed out after 30000ms'), false);
  vec('nostr-tools\' closed transport',
    new Error('this signer is not open anymore'), false);
  vec('a publish that no relay accepted',
    new AggregateError([new Error('refused')], 'All promises were rejected'), false);

  // A signer that answered "no" and meant it. These are the wrong-direction
  // cost: each must fail FAST, not after the approval budget.
  vec('a terminal refusal in other words', 'user rejected the request', false);
  vec('an unsupported method', 'unsupported method: nip44_decrypt', false);
  vec('a cipher it could not read', 'nip04_decrypt failed: Invalid base64', false);
  vec('a bare "denied"', 'denied', false);
  vec('a bare "error"', 'error', false);
  vec('a bare "pending"', 'pending', false);

  // Nothing at all.
  vec('an empty string', '', false);
  vec('whitespace only', '   \n ', false);
  vec('null', null, false);
  vec('undefined', undefined, false);
  vec('an object with a message field', { message: 'permission denied' }, false);
  vec('a number', 42, false);
}

// ---------------------------------------------------------------------------
section('The naive text-only matcher is replayed over EVERY vector');
// ---------------------------------------------------------------------------
{
  // Total, not a hand-written second list: a vector cannot be added without
  // being proved against the control. Vectors marked alsoNaive are the ones the
  // naive version is allowed to get right — it agrees on all ten of them,
  // which is exactly why this bug would survive a review.
  let disagreements = 0;
  let exempted = 0;
  for (const v of vectors) {
    const n = naive(v.input);
    if (n === v.expected) {
      if (v.alsoNaive) { exempted += 1; continue; }
      // Agreeing on a vector it was not exempted for is fine in itself; what
      // must not happen is the naive version agreeing EVERYWHERE.
      continue;
    }
    disagreements += 1;
  }
  check('every vector was replayed', vectors.length > 0, true);
  check('the naive matcher agrees on the ten it is exempted for', exempted, 10);
  check('...and is caught by at least one must-still-work vector',
    disagreements > 0, true);
  // Name the specific one, so a future edit that deletes it is visible.
  check('specifically: it retries an Error that reads "permission denied"',
    naive(new Error('permission denied')) === true
      && isApprovalPending(new Error('permission denied')) === false,
    true);
}

// ---------------------------------------------------------------------------
section('How big a NIP-46 request may be, and what it costs to measure it wrong');
// ---------------------------------------------------------------------------
//
// THE FAULT THIS PINS. NIP-44 v2 caps one plaintext at 65535 bytes, so a
// NIP-46 request past that is refused by nostr-tools before any relay is
// contacted — a local `Error`, which `bunker.ts` used to read as a dead
// transport and answer with "Signer disconnected — your iPhone may have
// suspended the relay link." Only ONE thing this app signs gets near it: a
// NIP-02 kind:3, the user's entire follow list in one event, at 77
// request-bytes per pubkey. Reported from an iPhone on Clave AND on Primal for
// the same tap, which is the tell — the throw is on this side of the wire.
//
// BOTH DIRECTIONS COST SOMETHING REAL, which is why the must-still-work half
// below is half of it:
//
//   under-measure   a request that cannot be sent is sent anyway, throws inside
//                   the library, and the user is told their signer is gone.
//   OVER-measure    a follow list that WOULD have signed is refused, and the
//                   refusal names a limit the user has not reached. There is no
//                   retry past it, so this is the expensive direction.
{
  const hex = (i) => i.toString(16).padStart(64, '0');
  // Built as the WIRE, not as a struct: this is exactly what nostr-tools'
  // `sendRequest('sign_event', [JSON.stringify(event)])` puts on the wire, so
  // the vectors carry the double-JSON escaping that is the whole subtlety.
  const kind3 = (n, content = '') => JSON.stringify({
    kind: 3,
    created_at: 1789000000,
    tags: Array.from({ length: n }, (_, i) => ['p', hex(i)]),
    content,
  });

  const sizeVectors = [];
  function sizeVec(label, call, expected, opts = {}) {
    sizeVectors.push({ label, call, expected, ...opts });
    check(label, nip46RequestFits(call.method, call.params), expected);
  }

  check('the ceiling is NIP-44 v2\'s u16 plaintext length', NIP46_MAX_REQUEST_BYTES, 65535);

  // THE BOUNDARY, MEASURED RATHER THAN ASSUMED. 849 is what a real
  // `nip44.encrypt` accepts and 850 is what it throws on — verified against
  // nostr-tools 2.19.4 itself, then written down here. If a version bump moves
  // the padding scheme these two numbers are where it shows.
  sizeVec('849 follows fits', { method: 'sign_event', params: [kind3(849)] }, true, { alsoNaive: true });
  sizeVec('850 follows does not', { method: 'sign_event', params: [kind3(850)] }, false);
  // The same list with a legacy relay-list `content`, which kind:3 carries and
  // this app preserves byte for byte. It costs follows.
  sizeVec('836 follows + a 1 KB content fits',
    { method: 'sign_event', params: [kind3(836, 'x'.repeat(1000))] }, true, { alsoNaive: true });
  sizeVec('837 follows + a 1 KB content does not',
    { method: 'sign_event', params: [kind3(837, 'x'.repeat(1000))] }, false);

  // MUST STILL WORK: everything else this app signs is nowhere near it, and a
  // guard that refused any of these would be worse than the bug it replaced.
  sizeVec('a boost note', { method: 'sign_event', params: [JSON.stringify({
    kind: 1, created_at: 1789000000, tags: [['t', 'v4v']], content: 'boosted 100 sats',
  })] }, true, { alsoNaive: true });
  sizeVec('a 200-entry favourites list', { method: 'sign_event', params: [JSON.stringify({
    kind: 10333, created_at: 1789000000, content: '',
    tags: Array.from({ length: 200 }, (_, i) => ['i', `podcast:guid:${hex(i)}`]),
  })] }, true, { alsoNaive: true });
  sizeVec('a 62-entry mute list', { method: 'sign_event', params: [JSON.stringify({
    kind: 10000, created_at: 1789000000, content: '',
    tags: Array.from({ length: 62 }, (_, i) => ['p', hex(i)]),
  })] }, true, { alsoNaive: true });
  sizeVec('an ordinary nip44 encrypt', { method: 'nip44_encrypt', params: [hex(1), 'hello'] }, true, { alsoNaive: true });

  // BYTES, NEVER `.length`. One emoji is one UTF-16 unit pair and four UTF-8
  // bytes, so a payload can be half the cap by `.length` and over it on the
  // wire. Nothing in this app writes 20k emoji, but the profile editor and the
  // boost note both hand user text to a signer, and the failure would land as
  // "your signer is gone" exactly like the kind:3 one did.
  sizeVec('20,000 emoji: under the cap by .length, over it in bytes',
    { method: 'nip44_encrypt', params: [hex(1), '\u{1F680}'.repeat(20000)] }, false);

  // The unit the guard actually reports, so a message quoting it cannot drift
  // from what it measured.
  check('a request is measured including its envelope',
    nip46RequestBytes('sign_event', [kind3(849)]) > 65000
      && nip46RequestBytes('sign_event', [kind3(849)]) <= 65535, true);

  // -------------------------------------------------------------------------
  // The naive version: measure the EVENT, and measure it in `.length`. It is
  // what you write from the method name alone, without reading that NIP-46
  // nests the event as a STRING — so every `"` is re-escaped and the real
  // request is ~5.6% bigger than the document you measured.
  function naiveSize(call) {
    return call.params.join('').length <= NIP46_MAX_REQUEST_BYTES;
  }
  let disagreements = 0;
  let exempted = 0;
  for (const v of sizeVectors) {
    const n = naiveSize(v.call);
    if (n === v.expected) { if (v.alsoNaive) exempted += 1; continue; }
    disagreements += 1;
  }
  check('every size vector was replayed', sizeVectors.length, 9);
  check('the naive measure agrees on the six it is exempted for', exempted, 6);
  check('...and is caught by at least one must-still-work vector', disagreements > 0, true);
  check('specifically: it waves through 850 follows, which nostr-tools throws on',
    naiveSize({ method: 'sign_event', params: [kind3(850)] }) === true
      && nip46RequestFits('sign_event', [kind3(850)]) === false, true);
}

// ---------------------------------------------------------------------------
section('MUST STILL WORK: only the encrypt-side refusal counts as "too large"');
// ---------------------------------------------------------------------------
{
  // The one message nostr-tools 2.19.4 raises, verbatim from `writeU16BE`.
  check('nostr-tools refusing to encrypt the request',
    isRequestTooLarge(new Error('invalid plaintext size: must be between 1 and 65535 bytes')), true);

  // OVER-MATCHING IS THE EXPENSIVE DIRECTION HERE TOO, and it is expensive in a
  // way the approval list is not: anything this predicate claims is NOT allowed
  // to mark the transport stale, so a real disconnect wearing one of these
  // words would leave the reconnect banner down and the user with no way back.
  check('an oversized payload arriving the OTHER way',
    isRequestTooLarge(new Error('invalid padding')), false);
  check('a relay refusing a large event',
    isRequestTooLarge(new AggregateError([new Error('invalid: event too large')], 'All promises were rejected')), false);
  check('our own timeout',
    isRequestTooLarge(new Error('Bunker sign_event timed out after 30000ms')), false);
  check('a closed transport',
    isRequestTooLarge(new Error('this signer is not open anymore')), false);
  // The type test, same as everywhere else in this file: a bare string is the
  // SIGNER talking, and a signer quoting our sentence back is not this fault.
  check('the same sentence as a bare string off the wire',
    isRequestTooLarge('invalid plaintext size: must be between 1 and 65535 bytes'), false);
  check('null', isRequestTooLarge(null), false);
  check('an object with a message field',
    isRequestTooLarge({ message: 'invalid plaintext size' }), false);
}

// ---------------------------------------------------------------------------
section('nip46-errors.ts stays loadable under plain Node');
// ---------------------------------------------------------------------------
{
  // The arrangement this whole script depends on: it imports the REAL module,
  // so the module must keep resolving under `node --experimental-strip-types`.
  // Do NOT fix a failure here by copying the predicate into this script — that
  // is the drift the arrangement exists to prevent. See scripts/import-free.mjs
  // for why a type-only relative import counts.
  const problems = importFreeProblems('lib/nostr/nip46-errors.ts');
  if (problems.length) { explainImportFree('lib/nostr/nip46-errors.ts', problems); failures += problems.length; }
  else console.log('  ok    lib/nostr/nip46-errors.ts has no imports at all');

  // clave.ts and primal.ts are not pinned by vectors — each builds one launch
  // URL, and a wrong one fails loudly at the first tap rather than silently —
  // but they are the other leaves the sign-in modal reads, and keeping them
  // import-free costs nothing and keeps the option open.
  for (const leaf of ['lib/nostr/clave.ts', 'lib/nostr/primal.ts']) {
    const problems = importFreeProblems(leaf);
    if (problems.length) { explainImportFree(leaf, problems); failures += problems.length; }
    else console.log(`  ok    ${leaf} has no imports at all`);
  }
}

// ---------------------------------------------------------------------------
section('The pairing URI still ASKS for permissions');
// ---------------------------------------------------------------------------
{
  // A SOURCE SCAN, AND IT IS HONEST ABOUT BEING ONE. `lib/nostr/bunker.ts`
  // imports nostr-tools and touches browser globals, so it can never be loaded
  // here the way nip46-errors.ts is — there is no version of this that calls
  // the real function. What it guards is the only failure that has actually
  // happened: the `perms` argument being absent from the call.
  //
  // WHY THAT IS WORTH A CHECK AT ALL. The URI shipped without `perms` for the
  // life of the Clave work, with a comment presenting it as a safety choice. It
  // is not one — it is what makes a signer prompt on EVERY call, so Clave
  // answered `no permission` to the handshake's own `get_public_key` and to
  // every signature after it, and `withApprovalWait` sat out a re-issue gap on
  // each. Sign-in, the boost note, the favorites publish and the mute publish
  // all paid it, and the whole thing presents as "it works, but it's slow" —
  // which is why it survived review. Deleting the argument would restore that
  // silently. See docs/signers.md.
  const src = readFileSync(new URL('../lib/nostr/bunker.ts', import.meta.url), 'utf8');
  const call = src.slice(src.indexOf('createNostrConnectURI({'));
  const inCall = call.slice(0, call.indexOf('\n  });'));
  check('createNostrConnectURI is passed perms', /\bperms:\s*NOSTRCONNECT_PERMS\b/.test(inCall), true);
  // Each of the six is a method this app actually calls through the adapter, so
  // a missing one is a signer prompt in the middle of a real feature. The
  // decrypts are the pair worth naming: without them the private mute half, the
  // private favorites half and "Restore from Nostr" die at the 10 s
  // withDecryptTimeout cap on any signer that prompts.
  for (const m of ['get_public_key', 'sign_event', 'nip44_encrypt', 'nip44_decrypt',
    'nip04_encrypt', 'nip04_decrypt']) {
    check(`NOSTRCONNECT_PERMS asks for ${m}`,
      new RegExp(`NOSTRCONNECT_PERMS[\\s\\S]*?'${m}'[\\s\\S]*?\\];`).test(src), true);
  }
}

if (failures) {
  console.error(`\n${failures} NIP-46 approval-pending check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll NIP-46 approval-pending checks passed.');
