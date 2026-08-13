// Pins the decision that says whether an EMPTY relay read means "nobody has it"
// or "nothing answered".
//
// Usage:
//   npm run check:readtrust
//
// Run it after ANY edit to lib/nostr/read-trust.ts or the relay accounting in
// lib/nostr/event-queries.ts.
//
// Why this earns a check script: every guard in this app that refuses to write
// over data it couldn't read is downstream of this one boolean. Publish a
// favorites list, a kind:3 follow list or a kind:0 profile on top of a read that
// silently failed and you don't degrade anything — you DELETE it, on someone
// else's device, with no error and no undo. The failure has no symptom on the
// machine that caused it.
//
// And it is a boolean that looks right while being wrong. The obvious
// implementation — trust the relay library's aggregate EOSE — folds two
// non-answers into "the query completed", both measured in a shipping app:
//
//   - A SYNTHESIZED EOSE. nostr-tools fakes one on a timer (baseEoseTimeout,
//     4400 ms) when a relay never sends one, so with a longer query window a
//     relay that accepted the socket and then went silent is indistinguishable
//     from one that answered "I have none".
//   - A FAILED CONNECTION counted as an answer, so with nothing reachable the
//     aggregate fires immediately and vacuously — 19 ms with no network at all.
//     Being offline reads as a cleared library.
//
// The must-still-work half is the over-blocking direction, and it is a real
// regression too: requiring every LISTED relay to answer means one permanently
// dead entry in a default list leaves every read degraded forever, and dead
// entries in default relay lists are common and long-lived precisely because
// nothing surfaces them. So "a dead relay must not degrade the read" is pinned
// as hard as "offline must".
//
// What this CANNOT pin is the wiring — that `reached` actually increments when
// a socket opens. That needs a scripted local relay that hangs, refuses, and
// serves someone else's event; a correct relay will not do any of those on
// request, so it can't be reproduced against the real network. This covers the
// arithmetic and the predicate, which is the half that is pure.
//
// `--experimental-strip-types` lets this .mjs import the real .ts module. That
// is the whole point: a reimplemented copy stays green while the shipping rule
// drifts. read-trust.ts is importable by plain Node because it has NO imports
// at all — keep it that way.

import {
  SYNTHETIC_EOSE_MARGIN_MS,
  acceptsEvent,
  readIsTrustworthy,
  syntheticEoseTimeoutFor,
} from '../lib/nostr/read-trust.ts';

// The two windows this app actually uses (lib/nostr/pool.ts) and the
// nostr-tools default the margin exists to clear.
const QUERY_MAX_WAIT_MS = 4000;
const FEED_QUERY_MAX_WAIT_MS = 8000;
const NOSTR_TOOLS_BASE_EOSE_TIMEOUT = 4400;

let failures = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) console.log(`       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const trust = (eventInHand, reached, answered) =>
  readIsTrustworthy({ eventInHand, reached, answered });

console.log('the empty read — is nothing an answer?');
{
  // THE bug. A failed connection ticks nostr-tools' aggregate, so with no
  // network it fired in 19ms and the app treated an empty list as real.
  check('offline — nothing reached — is NOT trustworthy', trust(false, 0, 0), false);

  // The must-still-work side of the same coin.
  check('every reached relay answered — trustworthy', trust(false, 5, 5), true);
  check('one reached relay answered — trustworthy', trust(false, 1, 1), true);

  // A relay that connected and then hung stays in the denominator: a genuine
  // unknown, and the read is degraded rather than silently short.
  check('one of five stayed silent — NOT trustworthy', trust(false, 5, 4), false);
  check('none of five answered — NOT trustworthy', trust(false, 5, 0), false);

  // An event in hand is its own proof the query worked, whatever else did.
  check('an event arrived, nothing else answered — trustworthy', trust(true, 5, 0), true);
  check('an event arrived with nothing reached — trustworthy', trust(true, 0, 0), true);
}

console.log('\nthe dead relay in the defaults — over-blocking is a regression too');
{
  // Never-connected relays are excluded from `reached` by the caller, so a
  // permanently dead default shows up here as a smaller denominator, NOT as an
  // unanswered one. Pinning this is what stops someone "tightening" the rule to
  // count listed relays and leaving every read degraded forever.
  check('4 of 5 listed connected and all answered — trustworthy', trust(false, 4, 4), true);
  check('1 of 5 listed connected and answered — trustworthy', trust(false, 1, 1), true);

  // Defensive: a miscount must fail OPEN on the arithmetic rather than wedge
  // the session at degraded, which is why the rule is >= and not ===.
  check('a double-counted answer does not wedge the read', trust(false, 2, 3), true);
}

console.log('\nthe synthetic EOSE — a timeout wearing an answer costume');
{
  // The margin's entire job: the library's fake EOSE must never fire INSIDE the
  // window we are counting in, for either window the app uses.
  check(
    'the 4s window clears nostr-tools 4400ms default',
    syntheticEoseTimeoutFor(QUERY_MAX_WAIT_MS) > NOSTR_TOOLS_BASE_EOSE_TIMEOUT,
    true,
  );
  check(
    'the 4s window outlives its own deadline',
    syntheticEoseTimeoutFor(QUERY_MAX_WAIT_MS) > QUERY_MAX_WAIT_MS,
    true,
  );
  // This is the one that was actually broken: 8000 > 4400, so every connected
  // relay on the feed path got a synthesized EOSE well inside the window and
  // `allEosed` reported "everyone answered" for relays that said nothing.
  check(
    'the 8s window outlives its own deadline',
    syntheticEoseTimeoutFor(FEED_QUERY_MAX_WAIT_MS) > FEED_QUERY_MAX_WAIT_MS,
    true,
  );

  // Kept SMALL deliberately: Subscription.close() does not clear the timer, so
  // it outlives the subscription. A big margin leaves it pending for longer.
  check('the margin stays under a second', SYNTHETIC_EOSE_MARGIN_MS <= 1000, true);
  check('the margin is not zero', SYNTHETIC_EOSE_MARGIN_MS > 0, true);
}

console.log('\nintake — reject at the door, never on the winner');
{
  const mine = { pubkey: 'aa11', kind: 30078, tags: [['d', 'podcast:favorites'], ['i', 'x']] };
  const theirs = { pubkey: 'bb22', kind: 30078, tags: [['d', 'podcast:favorites']] };
  const wrongList = { pubkey: 'aa11', kind: 30078, tags: [['d', 'podcast:favorites:items']] };
  const wrongKind = { pubkey: 'aa11', kind: 30003, tags: [['d', 'podcast:favorites']] };
  const expect = { pubkey: 'aa11', kinds: [30078], dTag: 'podcast:favorites' };

  check('my own event at the asked-for address', acceptsEvent(expect, mine), true);
  // Whatever lands is merged over and republished under the user's key, so a
  // foreign event is not merely wrong, it gets laundered into their favorites.
  check('another pubkey is rejected', acceptsEvent(expect, theirs), false);
  // The spec permits batching both d tags into one subscription, at which point
  // matchFilters accepts both and only this predicate can route them.
  check('the other list at the same kind is rejected', acceptsEvent(expect, wrongList), false);
  check('the legacy kind is rejected', acceptsEvent(expect, wrongKind), false);

  // An absent `d` must not read as a match for a named one.
  check(
    'an event with no d tag is rejected when one was asked for',
    acceptsEvent(expect, { pubkey: 'aa11', kind: 30078, tags: [] }),
    false,
  );
  check(
    'dTag: "" matches an event with no d tag',
    acceptsEvent({ dTag: '' }, { pubkey: 'aa11', kind: 10002, tags: [['r', 'wss://x']] }),
    true,
  );

  // An empty expectation accepts anything — callers pin only what they care
  // about, and `expect` is optional at the call site.
  check('an empty expectation accepts anything', acceptsEvent({}, theirs), true);
  check('a pubkey-only expectation ignores kind', acceptsEvent({ pubkey: 'aa11' }, wrongKind), true);
}

if (failures) {
  console.error(`\n${failures} read-trust check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll read-trust checks passed.');
