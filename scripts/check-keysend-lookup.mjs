// Pins the lnaddress → keysend routing decision.
//
// Usage:
//   npm run check:keysend
//
// Run it after ANY edit to lib/v4v/keysend-lookup.ts.
//
// Why this earns a check script: `isLnurlOnlyAddress` decides, per recipient,
// which of two payment rails a boost leg leaves on, and both directions are
// silent and cost someone something.
//
//   Under-match — fountain.fm stops matching and every @fountain.fm leg goes
//   back to being a keysend. Fountain ACCEPTS keysend; it just never shows the
//   recipient the TLV boostagram. So the payment succeeds, the sats land, the
//   modal shows a ✓, and the only evidence is metadata missing on someone
//   else's screen. This is the state the repo shipped in before this feature,
//   and no assertion about the payment itself would have caught it.
//
//   Over-match — a suffix test (`domain.endsWith('fountain.fm')`) also matches
//   `notfountain.fm`, so anyone who registers a hostname ending in a listed
//   domain gets to opt other people's recipients out of keysend and strip the
//   inline boostagram off their payments. Over-blocking is a real regression
//   here, not a safe default, which is why the must-NOT-match half below is
//   longer than the must-match half.
//
// `--experimental-strip-types` lets this .mjs import the real .ts module. That
// is the whole point: a reimplemented copy of the matcher stays green while the
// shipping one drifts, which is the exact failure being guarded.
// keysend-lookup.ts has NO imports at all — keep it that way so this works.

import {
  isLnurlOnlyAddress,
  lookupKeysendTarget,
  parseKeysendResponse,
  clearKeysendLookupCache,
} from '../lib/v4v/keysend-lookup.ts';

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) console.log(`       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

console.log('isLnurlOnlyAddress — addresses we always pay over LNURL');
{
  // The forms a real value block hands us. Case comes off attacker-authored
  // RSS text and the trailing root dot is the same host to DNS, so both must
  // normalize; the subdomain case is the reason this is a parent-match rather
  // than an equality test.
  const mustMatch = [
    ['a plain fountain address', 'chadf@fountain.fm'],
    ['mixed case normalizes', 'CHADF@Fountain.FM'],
    ['a trailing root dot is the same host', 'chadf@fountain.fm.'],
    ['surrounding whitespace is trimmed', 'chadf@ fountain.fm '],
    ['a subdomain is covered by its parent', 'chadf@wallet.fountain.fm'],
  ];
  for (const [label, addr] of mustMatch) check(label, isLnurlOnlyAddress(addr), true);
}

console.log('\nisLnurlOnlyAddress — addresses that must NOT be diverted');
{
  // Everything here would keysend today and must keep doing so. The first two
  // are the attack: a hostname chosen to end with, or to contain, a listed
  // domain. The rest are the ordinary providers whose keysend upgrade works and
  // is worth keeping — losing it costs them the inline boostagram.
  const mustNotMatch = [
    ['a domain merely ENDING in the listed one', 'x@notfountain.fm'],
    ['a domain merely ending in it, no dot boundary', 'x@myfountain.fm'],
    ['the listed domain as a PREFIX of someone else', 'x@fountain.fm.evil.example'],
    ['a lookalike TLD', 'x@fountain.fm.co'],
    ['an unrelated provider', 'x@getalby.com'],
    ['our own address', 'chadf@boostmebitch.com'],
    ['a bare domain with no @', 'fountain.fm'],
    ['an empty string', ''],
    ['an @ with nothing after it', 'chadf@'],
    ['a node pubkey, not an address', '03ae9f91a0cb8ff43840e3c322c4c61f019d8c1c3cea15a25cfc425ac605e61a4a'],
  ];
  for (const [label, addr] of mustNotMatch) check(label, isLnurlOnlyAddress(addr), false);
}

console.log('\nlookupKeysendTarget — a diverted address never reaches the network');
{
  // The short-circuit has to sit ahead of the fetch AND the cache, so prove it
  // by making any network call an error rather than a slow path that would
  // otherwise pass on a timeout returning null for the wrong reason.
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error('lookupKeysendTarget must not probe an LNURL-only domain');
  };
  try {
    clearKeysendLookupCache();
    const target = await lookupKeysendTarget('chadf@fountain.fm');
    check('an LNURL-only address resolves to no keysend target', target, null);
    check('…without any fetch', calls, 0);

    // The must-still-work half: a normal address DOES probe. Without this, a
    // matcher that returned true for everything would pass every check above.
    calls = 0;
    const other = await lookupKeysendTarget('someone@getalby.com');
    check('an ordinary address still attempts the probe', calls, 1);
    check('…and resolves to null when the probe throws', other, null);
  } finally {
    globalThis.fetch = realFetch;
    clearKeysendLookupCache();
  }
}

console.log('\nparseKeysendResponse — the divert did not leak into the parser');
{
  // A real Alby-shaped body. The parser is downstream of the routing decision
  // and must be untouched by it: if a future "just filter it in the parser"
  // refactor lands, this is what fails.
  const body = {
    status: 'OK',
    tag: 'keysend',
    pubkey: '03AE9F91A0CB8FF43840E3C322C4C61F019D8C1C3CEA15A25CFC425AC605E61A4A',
    customData: [{ customKey: '696969', customValue: 'vS6fLGA1BS6fLGA1' }],
  };
  check('a valid keysend document still parses', parseKeysendResponse(body), {
    pubkey: '03ae9f91a0cb8ff43840e3c322c4c61f019d8c1c3cea15a25cfc425ac605e61a4a',
    customKey: '696969',
    customValue: 'vS6fLGA1BS6fLGA1',
  });
}

console.log('\n(naive) the obvious matcher these vectors exist to reject');
{
  // A vector that passes the moment it is written has proved nothing. There is
  // no prior implementation to run these against — the function is new — so run
  // them against the obvious WRONG one instead. This is the version anyone
  // would reach for first, and it is the one that hands `notfountain.fm` the
  // ability to divert other people's payments.
  const naive = (address) => {
    const domain = address.split('@')[1]?.toLowerCase();
    return !!domain && domain.endsWith('fountain.fm');
  };
  const mustDiffer = ['x@notfountain.fm', 'x@myfountain.fm'];
  for (const addr of mustDiffer) {
    check(`(naive) disagrees on ${addr}`, isLnurlOnlyAddress(addr) !== naive(addr), true);
  }
  // …and agrees where it should, so the divergence above is specific rather
  // than this being a different function that happens to differ everywhere.
  for (const addr of ['chadf@fountain.fm', 'x@getalby.com']) {
    check(`(naive) agrees on ${addr}`, isLnurlOnlyAddress(addr) === naive(addr), true);
  }
}

if (failures) {
  console.error(`\n${failures} keysend-routing check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll keysend-routing checks passed.');
