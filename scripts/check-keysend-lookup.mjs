// Pins the lnaddress → keysend routing decision.
//
// Usage:
//   npm run check:keysend
//
// Run it after ANY edit to lib/v4v/keysend-lookup.ts.
//
// Why this earns a check script: `isLnurlOnlyAddress` and the failure demotion
// decide, per recipient, which of two payment rails a boost leg leaves on, and
// every direction is silent and costs someone something.
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
  keysendRecentlyFailed,
  lookupKeysendTarget,
  noteKeysendFailure,
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

console.log('\nnoteKeysendFailure — a target that does not pay is demoted, once');
{
  // The case: an address publishing a valid .well-known/keysend whose node
  // cannot actually be paid. The document keeps saying yes, so without a memory
  // the same leg fails on every boost and every track of a boost-all, forever —
  // and a value block's fee recipients ride on all of them.
  //
  // What it must NOT do is rescue the leg that failed. That leg was attempted
  // and may have paid; see failureBlamesDestination and payOne. This is only
  // about where the NEXT leg goes, which is what makes it safe to be liberal.
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error('lookupKeysendTarget must not probe a demoted address');
  };
  try {
    clearKeysendLookupCache();
    check('an untouched address is not demoted', keysendRecentlyFailed('pi@example.com'), false);

    noteKeysendFailure('pi@example.com');
    check('a failed keysend demotes the address', keysendRecentlyFailed('pi@example.com'), true);

    calls = 0;
    check('a demoted address resolves to no keysend target',
      await lookupKeysendTarget('pi@example.com'), null);
    check('…without any fetch', calls, 0);

    // The address is a value-block string, so it arrives in whatever case and
    // spacing the feed author used — and app/api/keysend lowercases on its side.
    check('the demotion is case-insensitive', keysendRecentlyFailed('PI@Example.com'), true);
    check('…and survives surrounding whitespace', keysendRecentlyFailed(' pi@example.com '), true);

    // The must-still-work half. Over-demoting is a real regression: it costs
    // every other recipient the inline boostagram, silently, on a payment that
    // still succeeds.
    check('an unrelated address is untouched', keysendRecentlyFailed('artist@getalby.com'), false);
    calls = 0;
    check('…and still attempts its probe', await lookupKeysendTarget('artist@getalby.com'), null);
    check('…having actually fetched', calls, 1);

    // It lapses on its own. A wrong demotion — a wallet fault misread as the
    // recipient's — must not need a user to find a setting to undo it.
    let clock = realNow();
    Date.now = () => clock;
    clearKeysendLookupCache();
    noteKeysendFailure('pi@example.com');
    clock += 6 * 60 * 60 * 1000 - 1000;
    check('the demotion holds just inside its window',
      keysendRecentlyFailed('pi@example.com'), true);
    clock += 2000;
    check('…and lapses just outside it', keysendRecentlyFailed('pi@example.com'), false);
    Date.now = realNow;

    // An empty address is not a demotion of every empty-ish string.
    clearKeysendLookupCache();
    noteKeysendFailure('   ');
    check('a blank address records nothing', keysendRecentlyFailed(''), false);

    // THE vector, and the one a cold cache cannot express. Same placement rule
    // as the LNURL-only divert: the short-circuit sits ahead of the CACHE, not
    // just ahead of the fetch. A demoted address still publishes a valid
    // document, so by the time it fails we are already holding a cached hit for
    // it — and this is the ordinary state, not an edge case. It is precisely
    // the boost-all shape: leg 1 probes the address, caches the target, pays it
    // and fails; every later leg reads that cached hit. Check the demotion
    // after the cache instead of before and each of them keysends again, which
    // is the bug this whole memory exists to end, still passing every cold-cache
    // assertion above.
    clearKeysendLookupCache();
    const doc = {
      status: 'OK',
      tag: 'keysend',
      pubkey: '03ae9f91a0cb8ff43840e3c322c4c61f019d8c1c3cea15a25cfc425ac605e61a4a',
      customData: [{ customKey: '906608', customValue: '1a2b3c' }],
    };
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: true, json: async () => doc };
    };
    calls = 0;
    check('a live address resolves to its published target', await lookupKeysendTarget('pi@example.com'), {
      pubkey: '03ae9f91a0cb8ff43840e3c322c4c61f019d8c1c3cea15a25cfc425ac605e61a4a',
      customKey: '906608',
      customValue: '1a2b3c',
    });
    check('…having probed once', calls, 1);
    check('…and the second leg is served from cache, still upgraded',
      (await lookupKeysendTarget('pi@example.com'))?.pubkey,
      '03ae9f91a0cb8ff43840e3c322c4c61f019d8c1c3cea15a25cfc425ac605e61a4a');
    check('…without probing again', calls, 1);

    noteKeysendFailure('pi@example.com');
    check('after the keysend fails, the WARM cache no longer serves the target',
      await lookupKeysendTarget('pi@example.com'), null);
    check('…and it did not re-probe to find that out', calls, 1);
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
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
