// Pin the kind:33369 summary arithmetic and, above all, the ONE predicate that
// decides whether a summary may be published.
//
// WHY THIS FILE EXISTS. A 33369 is addressable, so there is exactly one event
// per (pubkey, kind, d). A person signed into two apps on one key therefore has
// two writers at a single address, and the obvious implementation — keep a
// running total, add to it, publish — is destroyed by the other writer every
// time. The shipping fix is that a summary is DERIVED from the receipts, plus
// two rules on top:
//
//   MONOTONIC        amount and count never decrease at an address. A writer
//                    deriving less has an incomplete view, not a smaller truth.
//   CHANGED BY VALUE compare the two numbers, never the event bytes.
//
// Both rules are invisible in review and neither can fail a single-writer test.
// A wrong implementation publishes correct-looking events for months and only
// misbehaves once somebody opens a second app — at which point the symptom is
// two devices rewriting one address forever, every publish locally reasonable.
//
// So the vectors are recorded as CALLS ({ kind, args }) and the replay walks
// the whole list: a vector cannot be added without also being proved to fail
// against `naive()` at the foot of this file. That is the discipline
// check-assetlinks.mjs adopted after shipping a header claiming every vector
// was replayed beside a footer that named six of twenty-nine by hand. The
// must-still-work half is exempted ONE VECTOR AT A TIME with `alsoNaive: true`,
// never by default.
//
// There is one `naive()` PER KIND — `decision`, `facts`, `matches`, `derive`,
// `parse` — and each is the version somebody would actually write, not a
// strawman: every one of them passes a single-writer test. The decision one
// publishes whenever the numbers differ, with no monotonicity check at all, so
// it happily lowers a total on a partial read; that is the bug no single device
// can see.
//
// **A new function pinned here needs a recorder AND a naive, or its vectors
// prove nothing.** The replay refuses a kind it has no implementation for
// rather than comparing two absences and passing — this file previously
// recorded only `decision`, so roughly twenty assertions across the other four
// functions sat green having been compared against nothing, under a header that
// said otherwise.

import {
  receiptFacts,
  receiptMatchesId,
  deriveSummary,
  parseStoredSummary,
  summaryPublishDecision,
  VALUE_PLAYBACK_SUMMARY_KIND,
} from '../lib/nostr/value-playback-summary.ts';
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

// Every assertion below goes through one of these, and every one of them
// RECORDS the call. That is the whole point: a bare `eq()` is an assertion the
// replay cannot see, so it sits green having been compared against nothing —
// which is precisely how check-assetlinks.mjs came to have a header claiming
// total coverage over a footer that named six vectors of twenty-nine by hand.
// Adding a function here without a recorder re-opens that hole.
//
// `alsoNaive` marks a must-still-work input: a legitimate value the wrong
// implementation also handles. It is a property of that input, never a default.
function record(kind, label, args, alsoNaive) {
  vectors.push({ label, kind, args, alsoNaive });
}

function checkDecision(label, derived, stored, expected, { alsoNaive = false } = {}) {
  eq(label, summaryPublishDecision(derived, stored), expected);
  record('decision', label, [derived, stored], alsoNaive);
}

function checkFacts(label, tags, createdAt, expected, { alsoNaive = false } = {}) {
  eq(label, receiptFacts(tags, createdAt), expected);
  record('facts', label, [tags, createdAt], alsoNaive);
}

function checkMatches(label, tags, id, expected, { alsoNaive = false } = {}) {
  eq(label, receiptMatchesId(tags, id), expected);
  record('matches', label, [tags, id], alsoNaive);
}

function checkDerive(label, facts, expected, { alsoNaive = false } = {}) {
  eq(label, deriveSummary(facts), expected);
  record('derive', label, [facts], alsoNaive);
}

function checkParse(label, tags, expected, { alsoNaive = false } = {}) {
  eq(label, parseStoredSummary(tags), expected);
  record('parse', label, [tags], alsoNaive);
}

const d = (amount, count, first = 0, last = 0) => ({ amount, count, first, last });

// ---------------------------------------------------------------------------
console.log('\nthe kind is the one the spec assigns');
// ---------------------------------------------------------------------------
eq('summary kind is 33369', VALUE_PLAYBACK_SUMMARY_KIND, 33369);

// ---------------------------------------------------------------------------
console.log('\nreceiptFacts — what one receipt contributes');
// ---------------------------------------------------------------------------
{
  const tags = [
    ['i', 'podcast:guid:c90e609a-df1e-596a-bd5e-57bcc8aad6cc'],
    ['k', 'podcast:guid'],
    ['amount', '30000'],
    ['action', 'auto'],
  ];
  checkFacts('reads amount and created_at', tags, 1740000180, {
    amountMsat: 30000,
    createdAt: 1740000180,
  }, { alsoNaive: true });

  // A missing amount must not become a zero-sat receipt. It would leave the
  // total right and the COUNT wrong, and count is the field a consumer uses to
  // decide whether a summary is behind — so a phantom entry makes an accurate
  // summary look permanently stale.
  checkFacts('no amount tag is dropped, not counted as 0',
    [['i', 'podcast:guid:x']], 1740000180, null);
  checkFacts('empty amount is dropped (Number("") is 0)',
    [['amount', '']], 1740000180, null);
  checkFacts('non-numeric amount is dropped',
    [['amount', '30000 msat']], 1740000180, null);
  checkFacts('negative amount is dropped',
    [['amount', '-30000']], 1740000180, null);
  checkFacts('fractional amount is dropped',
    [['amount', '30000.5']], 1740000180, null);
  // Whitespace is tolerated on the way IN but must still parse to the number,
  // never to NaN and never to 0.
  checkFacts('padded amount parses to the number',
    [['amount', ' 30000 ']], 1740000180, { amountMsat: 30000, createdAt: 1740000180 },
    { alsoNaive: true });
  checkFacts('a genuine zero-sat receipt is kept',
    [['amount', '0']], 1740000180, { amountMsat: 0, createdAt: 1740000180 },
    { alsoNaive: true });
  // `created_at` is the other half of a fact and is validated too — it sets
  // `first`/`last`, so a garbage timestamp does not merely look odd, it moves
  // the bounds a second writer compares against.
  checkFacts('a negative created_at is dropped', [['amount', '30000']], -1, null);
  checkFacts('a non-integer created_at is dropped', [['amount', '30000']], 1.5, null);
}

// ---------------------------------------------------------------------------
console.log('\nreceiptMatchesId — the relay filter is not proof');
// ---------------------------------------------------------------------------
{
  const ID = 'podcast:guid:c90e609a-df1e-596a-bd5e-57bcc8aad6cc';
  const tags = [
    ['i', ID],
    ['k', 'podcast:guid'],
    ['i', 'podcast:item:guid:d98d189b-dc7b-45b1-8720-d4b98690f31f'],
    ['k', 'podcast:item:guid'],
  ];
  checkMatches('matches the feed id', tags, ID, true, { alsoNaive: true });
  checkMatches('matches the item id it also carries', tags,
    'podcast:item:guid:d98d189b-dc7b-45b1-8720-d4b98690f31f', true, { alsoNaive: true });
  checkMatches('does not match an id it does not carry', tags,
    'podcast:guid:00000000-0000-0000-0000-000000000000', false, { alsoNaive: true });
  // A prefix test would count a longer guid toward a shorter one. Over-counting
  // a total is silent — the event still looks well-formed.
  checkMatches('a longer id sharing the prefix does not match',
    [['i', ID + '-extra']], ID, false, { alsoNaive: true });
  checkMatches('a shorter prefix of a carried id does not match', tags,
    'podcast:guid:c90e609a', false, { alsoNaive: true });
  // `k` names the kind, never the entry. Reading it as one lets any receipt
  // count toward any feed of that kind — which is what the naive version does.
  checkMatches('a k tag is not an entry', [['k', ID]], ID, false);
  checkMatches('an empty id matches nothing', tags, '', false, { alsoNaive: true });
  // The guard is what makes the empty-id case total: without it, a tag whose
  // own value is empty answers yes to "do you carry the empty id".
  checkMatches('an empty id does not match an empty tag value', [['i', '']], '', false);
}

// ---------------------------------------------------------------------------
console.log('\nderiveSummary — order-independent, which is what lets two apps agree');
// ---------------------------------------------------------------------------
{
  const a = { amountMsat: 30000, createdAt: 1740000180 };
  const b = { amountMsat: 12000, createdAt: 1739900000 };
  const c = { amountMsat: 1000, createdAt: 1740000000 };
  const bounds = { amount: 43000, count: 3, first: 1739900000, last: 1740000180 };
  checkDerive('sums and bounds', [a, b, c], bounds);
  // Relays return events in no particular order, so a second writer only agrees
  // with the first if the derivation does not depend on arrival order. The naive
  // version reads facts[0] and facts[n-1] — right only for a sorted array, which
  // is exactly what one device's own receipts look like.
  checkDerive('reversed input gives the identical result', [c, b, a], bounds);
  checkDerive('empty is zero and reports no bounds', [], {
    amount: 0, count: 0, first: 0, last: 0,
  }, { alsoNaive: true });
  // `first` starts at 0 as a sentinel; a single receipt must set it, not keep 0.
  checkDerive('one receipt sets both bounds to itself', [a], {
    amount: 30000, count: 1, first: 1740000180, last: 1740000180,
  }, { alsoNaive: true });
}

// ---------------------------------------------------------------------------
console.log('\nparseStoredSummary — an unreadable value must not freeze the address');
// ---------------------------------------------------------------------------
{
  checkParse('reads amount and count', [
    ['d', 'podcast:guid:x'], ['amount', '1420000'], ['count', '84'],
  ], { amount: 1420000, count: 84 }, { alsoNaive: true });
  checkParse('missing count is unreadable', [['amount', '1420000']], null);
  checkParse('missing amount is unreadable', [['count', '84']], null);
  checkParse('garbage is unreadable', [['amount', 'lots'], ['count', '84']], null);
}

// ---------------------------------------------------------------------------
console.log('\nsummaryPublishDecision — monotonic, and changed BY VALUE');
// ---------------------------------------------------------------------------

// The ordinary case, and the only one a single-writer test ever reaches.
//
// Everything in this block is marked `alsoNaive`. These vectors assert the
// feature KEEPS WORKING — publish a first summary, publish a grown one, stay
// quiet when nothing moved — and a wrong implementation gets them right too.
// That is a property of the input, not a hole in the vector, and it is why the
// exemption is per-vector and never the default: the moment it becomes a
// blanket the monotonicity vectors below stop being proved against anything.
// Over-blocking is a real regression as well, so the must-still-work half has
// to be here.
checkDecision('first publish over an empty address', d(43000, 3), null,
  { publish: true, reason: 'publish' }, { alsoNaive: true });
checkDecision('a grown total publishes', d(43000, 3), { amount: 30000, count: 2 },
  { publish: true, reason: 'publish' }, { alsoNaive: true });

// Nothing to say. A derivation over zero receipts is not a total of zero — it
// is the absence of anything to claim, and an empty summary puts a figure on
// the wire that nothing backs.
checkDecision('no receipts never creates a summary', d(0, 0), null,
  { publish: false, reason: 'no-receipts' });
checkDecision('no receipts never overwrites one either', d(0, 0), { amount: 43000, count: 3 },
  { publish: false, reason: 'no-receipts' });

// CHANGED BY VALUE. Recomputing on every listen produces the same numbers
// almost every time; republishing them is pure relay churn on a kind whose own
// spec names rate limits as the binding constraint.
checkDecision('an unchanged total publishes nothing', d(43000, 3), { amount: 43000, count: 3 },
  { publish: false, reason: 'unchanged' }, { alsoNaive: true });

// MONOTONIC. This is the half that cannot fail on one device, and every one of
// these is what a partial relay read looks like.
checkDecision('a shrunk amount is a partial read, not a smaller truth',
  d(30000, 3), { amount: 43000, count: 3 },
  { publish: false, reason: 'would-shrink' });
checkDecision('a shrunk count is a partial read too',
  d(43000, 2), { amount: 43000, count: 3 },
  { publish: false, reason: 'would-shrink' });
checkDecision('both shrunk',
  d(30000, 2), { amount: 43000, count: 3 },
  { publish: false, reason: 'would-shrink' });

// The mixed case is why the guard is `>=` on BOTH fields rather than `!==` on
// either. A partial read that happened to include one large receipt has a
// bigger amount and a smaller count; publishing it would LOWER count, which is
// the field a consumer uses to tell that a summary is behind.
checkDecision('amount grew but count shrank is still a partial read',
  d(90000, 2), { amount: 43000, count: 3 },
  { publish: false, reason: 'would-shrink' });
// And its mirror, which an implementation comparing only `amount` gets wrong.
checkDecision('count grew while amount shrank is a partial read',
  d(30000, 4), { amount: 43000, count: 3 },
  { publish: false, reason: 'would-shrink' });

// Only one field needs to move for there to be something to say. A zero-sat
// receipt raises count without raising amount, and it is still news.
checkDecision('count alone growing publishes', d(43000, 4), { amount: 43000, count: 3 },
  { publish: true, reason: 'publish' }, { alsoNaive: true });
checkDecision('amount alone growing publishes', d(50000, 3), { amount: 43000, count: 3 },
  { publish: true, reason: 'publish' }, { alsoNaive: true });

// An unreadable stored value cannot bound anything. Refusing to publish over it
// would let one malformed event freeze an address permanently.
checkDecision('an unreadable stored summary does not block the write', d(43000, 3), null,
  { publish: true, reason: 'publish' }, { alsoNaive: true });

// ---------------------------------------------------------------------------
console.log('\nevery decision vector fails against the obvious wrong implementation');
// ---------------------------------------------------------------------------
{
  // What somebody would actually write: derive, compare to what is stored,
  // publish if it differs. No monotonicity anywhere. It is correct on every
  // single-writer path and lowers the total the first time a relay read is
  // short — which is exactly the failure no one device can observe.
  // One naive per recorded kind, and each is the version somebody would actually
  // write — not a strawman. Every one of them passes a single-writer test.
  const naiveTagValue = (tags, name) => {
    for (const t of tags) if (t[0] === name) return t[1];
    return undefined;
  };

  const naive = {
    // Publish whenever the numbers differ. No monotonicity at all, so it lowers
    // a total the first time a relay read comes back short — the failure no one
    // device can observe.
    decision: (derived, stored) => {
      if (!stored) return { publish: true, reason: 'publish' };
      if (derived.amount === stored.amount && derived.count === stored.count) {
        return { publish: false, reason: 'unchanged' };
      }
      return { publish: true, reason: 'publish' };
    },
    // `Number()` and a `?? 0`, which is what reading a tag looks like when you
    // are not thinking about the absent case. A receipt with no readable amount
    // becomes a real zero-sat entry: the total stays right and `count` gains a
    // phantom, so an accurate summary looks permanently behind.
    facts: (tags, createdAt) => ({
      amountMsat: Number(naiveTagValue(tags, 'amount') ?? 0),
      createdAt,
    }),
    // Search the tag VALUES and forget that the tag NAME carries meaning. `k`
    // holds the identifier kind, so this counts any receipt of that kind toward
    // any feed of that kind.
    matches: (tags, id) => tags.some((t) => t[1] === id),
    // Assume the array arrived sorted, which is true of one device's own
    // receipts and false of anything a relay returns.
    derive: (facts) => ({
      amount: facts.reduce((n, f) => n + f.amountMsat, 0),
      count: facts.length,
      first: facts.length ? facts[0].createdAt : 0,
      last: facts.length ? facts[facts.length - 1].createdAt : 0,
    }),
    // Same missing-value blindness as `facts`, one level up: an unreadable
    // stored summary reads as NaN rather than as "we could not read it", and
    // NaN compares false against everything, so the address is rewritten every
    // cycle forever.
    parse: (tags) => ({
      amount: Number(naiveTagValue(tags, 'amount')),
      count: Number(naiveTagValue(tags, 'count')),
    }),
  };

  const real = {
    decision: summaryPublishDecision,
    facts: receiptFacts,
    matches: receiptMatchesId,
    derive: deriveSummary,
    parse: parseStoredSummary,
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
console.log('\nvalue-playback-summary.ts stays loadable under plain Node');
// ---------------------------------------------------------------------------
{
  const problems = importFreeProblems('lib/nostr/value-playback-summary.ts');
  if (problems.length === 0) {
    console.log('  ok    no imports at all');
  } else {
    failures += 1;
    console.error('  FAIL  this module must stay import-free');
    for (const p of problems) console.error(`          ${p}`);
    console.error(explainImportFree());
  }
}

console.log(
  failures === 0
    ? '\nAll value-playback-summary checks passed.\n'
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
