// Pins the two pure functions behind the NWC balance display: how a NIP-47
// `get_budget` response is read, and which of the wallet's balance and the
// connection's budget the app may say is spendable.
//
// Usage:
//   npm run check:nwcbudget
//
// Run it after ANY edit to `parseNwcBudget` / `spendableSats` in lib/util.ts,
// or to `nwcGetBudget` / `nwcGetSpendable` in lib/v4v/nwc.ts.
//
// Why this earns a check script. The number these produce sits next to a send
// button, and BOTH failure directions are silent.
//
// Reading too little is the shape that shipped: `get_balance` on a connection
// to your own node answers with the NODE's balance, while the grant this app
// holds is whatever budget the connection was created with. The header chip
// then advertised 9,017,493 spendable sats over a budget that would refuse the
// next boost — a number that is not wrong about anything except the only
// question being asked of it.
//
// Reading too much is worse, because it takes a working wallet off the air. A
// null from `parseNwcBudget` means "no budget applies" and falls the caller
// back to the balance, which is what this app displayed before budgets were
// read at all — so every doubtful input MUST reach null. A `{}` (NIP-47's
// answer for an unbudgeted connection), an "unlimited" modelled as a zero
// total, and an absent field parsed as `NaN` each otherwise produce a budget
// of zero remaining: the chip reads 0, the boost modal paints its
// insufficient-funds warning in magenta over a funded wallet, and nothing on
// screen distinguishes that from a wallet that really is spent. `NaN` is the
// nastiest of the three, since it compares false against every bound and
// renders as the literal string "NaN".
//
// `spendableSats` is the seam where a legitimately small budget meets a
// legitimately small balance. It takes the MINIMUM because either one running
// out fails the payment, and its `budgetLimited` flag is what the surfaces use
// to explain the number — so a strict comparison matters: a budget LARGER than
// the balance is not the reason the number is what it is, and saying it is
// sends the user looking for a spending limit that isn't binding.
//
// The arithmetic lives in lib/util.ts, whose only import is type-only and
// therefore erased by type stripping, so this script imports the REAL
// functions under `node --experimental-strip-types`. lib/v4v/nwc.ts cannot be
// loaded that way — it imports ../storage and the Alby SDK — which is why the
// parsing was moved out of it rather than pinned where it is used.
//
// EVERY VECTOR IS A RECORDED CALL, NOT A BARE ASSERTION. `naiveParse` and
// `naiveSpendable` at the foot are the versions somebody would actually write
// — subtract used from total, take the minimum — and the whole list is
// replayed against them, because a vector that passes the moment it is written
// has proved nothing. There is one naive() PER KIND and the replay refuses a
// kind it has no implementation for, rather than comparing two absences.
//
// Exemptions are named one at a time with `alsoNaive: true`, never as a
// default: a legitimate input the wrong implementation also handles is a
// property of that input, not a hole in the suite.

import { parseNwcBudget, spendableSats } from '../lib/util.ts';

let failures = 0;

/** Every recorded call, replayed against the wrong implementations below. */
const vectors = [];

function compare(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
}

/** A parseNwcBudget vector. `alsoNaive` marks a must-still-work input. */
function checkParse(label, input, expected, { alsoNaive = false } = {}) {
  compare(label, parseNwcBudget(input), expected);
  vectors.push({ label, kind: 'parse', args: [input], alsoNaive });
}

/** A spendableSats vector. `alsoNaive` marks a must-still-work input. */
function checkSpendable(label, balance, budget, expected, { alsoNaive = false } = {}) {
  compare(label, spendableSats(balance, budget), expected);
  vectors.push({ label, kind: 'spend', args: [balance, budget], alsoNaive });
}

function section(name) {
  console.log(`\n${name}`);
}

/** Shorthand for the parsed shape, so the expectations below read as data. */
const budget = (usedSats, totalSats, extra = {}) => ({
  usedSats,
  totalSats,
  remainingSats: Math.max(0, totalSats - usedSats),
  renewsAt: undefined,
  renewalPeriod: undefined,
  ...extra,
});

// ---------------------------------------------------------------------------
section('parseNwcBudget — the wire is msat, the screen is sats');
// ---------------------------------------------------------------------------

// The ordinary answer from a budgeted Alby Hub connection: 100k sats a month,
// 2,340 of them spent. This is the case the whole feature exists for.
checkParse(
  'a monthly budget with some of it spent',
  { used_budget: 2_340_000, total_budget: 100_000_000, renews_at: 1788220800, renewal_period: 'monthly' },
  budget(2_340, 100_000, { renewsAt: 1788220800, renewalPeriod: 'monthly' }),
  // A well-formed answer is what any implementation gets right. Exempt: this
  // pins the conversion, not the guards.
  { alsoNaive: true },
);

checkParse(
  'an untouched budget',
  { used_budget: 0, total_budget: 21_000_000, renewal_period: 'weekly' },
  budget(0, 21_000, { renewalPeriod: 'weekly' }),
  { alsoNaive: true },
);

// Sats FLOOR, both fields. Rounding up can only overstate what is spendable,
// and this number sits beside a send button.
checkParse(
  'msat remainders floor rather than round',
  { used_budget: 1_999, total_budget: 10_999 },
  budget(1, 10),
  // Both implementations floor; the vector exists so a future edit to ROUND is
  // caught by the assertion above rather than by a user overspending by a sat.
  { alsoNaive: true },
);

// A budget the wallet has just shrunk. `used > total` is an ordinary state and
// means zero remaining — rejecting it would restore the full balance to the
// screen at the moment the connection can spend nothing.
checkParse(
  'used past total clamps to zero remaining, it does not go negative',
  { used_budget: 60_000_000, total_budget: 50_000_000 },
  budget(60_000, 50_000),
);

// --- the four inputs that MUST reach null -----------------------------------

// NIP-47's own answer for a connection with no budget.
checkParse('an empty object is no budget', {}, null);

// Wallets that model "unlimited" as a zero total. Read literally this is a
// budget of nothing, which reads on screen as an empty wallet.
checkParse('a zero total is no budget, NOT a budget of zero', { used_budget: 0, total_budget: 0 }, null);
checkParse('a negative total is no budget', { used_budget: 0, total_budget: -1 }, null);

// `Number(undefined)` is NaN, and NaN compares false against every bound, so
// an unguarded parse yields a budget whose every field renders as "NaN".
checkParse('a missing total is no budget', { used_budget: 5_000 }, null);
checkParse('a non-numeric total is no budget', { total_budget: 'lots', used_budget: 0 }, null);
checkParse('a null total is no budget', { total_budget: null, used_budget: 0 }, null);
checkParse('an Infinity total is no budget', { total_budget: Infinity, used_budget: 0 }, null);
checkParse('a non-numeric used amount is no budget', { total_budget: 100_000_000, used_budget: 'some' }, null);
checkParse('a negative used amount is no budget', { total_budget: 100_000_000, used_budget: -1_000 }, null);

// A missing `used_budget` is not the same fault: it defaults to 0, which is a
// true statement about a fresh budget and the one field a wallet may omit.
checkParse(
  'a missing used amount reads as nothing spent',
  { total_budget: 100_000_000 },
  budget(0, 100_000),
);

// Not-an-object shapes. A wallet that answers with a string, or a caller that
// hands over a rejected promise's value, must not produce a spending limit.
checkParse('null is no budget', null, null, { alsoNaive: true });
checkParse('undefined is no budget', undefined, null, { alsoNaive: true });
checkParse('a string is no budget', 'unlimited', null, { alsoNaive: true });
checkParse('a number is no budget', 0, null, { alsoNaive: true });

// The optional fields are optional, and a wallet wording them oddly must not
// cost the budget itself.
checkParse(
  'a non-string renewal period is dropped, the budget survives',
  { used_budget: 0, total_budget: 1_000_000, renewal_period: 7 },
  budget(0, 1_000),
);
checkParse(
  'a zero renews_at is dropped, the budget survives',
  { used_budget: 0, total_budget: 1_000_000, renews_at: 0 },
  budget(0, 1_000),
);

// ---------------------------------------------------------------------------
section('spendableSats — the smaller of the two, and which one binds');
// ---------------------------------------------------------------------------

// The reported case: a node holding millions behind a small app budget.
checkSpendable(
  'a small budget over a large balance is the budget',
  9_017_493, budget(97_660, 100_000),
  { sats: 2_340, budgetLimited: true },
  // The minimum is the obvious half and every implementation takes it. What
  // this vector pins is the number the reported bug got wrong.
  { alsoNaive: true },
);

// The other way round. The balance binds, so the number is NOT explained as a
// spending limit — the user would go looking for one that is not there.
checkSpendable(
  'a large budget over a small balance is the balance, and is NOT budget-limited',
  5_000, budget(0, 100_000),
  { sats: 5_000, budgetLimited: false },
);

checkSpendable(
  'an exhausted budget spends nothing',
  9_017_493, budget(100_000, 100_000),
  { sats: 0, budgetLimited: true },
  { alsoNaive: true },
);

checkSpendable(
  'equal figures are not called budget-limited',
  10_000, budget(0, 10_000),
  { sats: 10_000, budgetLimited: false },
);

// No budget at all — every Spark and WebLN read, and every unbudgeted NWC one.
checkSpendable(
  'no budget passes the balance straight through',
  9_017_493, null,
  { sats: 9_017_493, budgetLimited: false },
  { alsoNaive: true },
);

checkSpendable(
  'an empty wallet with no budget is still not budget-limited',
  0, null,
  { sats: 0, budgetLimited: false },
  { alsoNaive: true },
);

// ---------------------------------------------------------------------------
section('every vector replayed against the wrong implementations');
// ---------------------------------------------------------------------------
{
  /**
   * Subtract used from total and call it a budget. It is what the NIP-47 field
   * names invite, and it gets every ordinary answer right — which is exactly
   * why it survives review. It produces a budget of ZERO for `{}`, for an
   * "unlimited" zero total, and (as NaN) for a missing field.
   */
  const naiveParse = (res) => {
    if (!res || typeof res !== 'object') return null;
    const totalSats = Math.floor(Number(res.total_budget) / 1000);
    const usedSats = Math.floor(Number(res.used_budget) / 1000);
    return {
      usedSats,
      totalSats,
      remainingSats: totalSats - usedSats,
      renewsAt: res.renews_at,
      renewalPeriod: res.renewal_period,
    };
  };

  /**
   * The minimum, with "a budget exists" mistaken for "the budget binds". Right
   * about the number every time and wrong about the explanation whenever the
   * balance is the smaller of the two.
   */
  const naiveSpendable = (balanceSats, b) => ({
    sats: b ? Math.min(balanceSats, b.remainingSats) : balanceSats,
    budgetLimited: !!b,
  });

  // `JSON.stringify` is NOT usable as the comparison. It renders NaN as the
  // literal `null` — the same text as a real refusal — so every vector probing
  // an unguarded `Number()` would read as "naive gets this right too" and
  // would be deleted as proving nothing. They prove the most.
  const repr = (v) => {
    if (v === null || v === undefined) return `${typeof v}:${String(v)}`;
    if (typeof v !== 'object') return `${typeof v}:${String(v)}`;
    return Object.keys(v)
      .sort()
      .map((k) => `${k}=${typeof v[k]}:${String(v[k])}`)
      .join(',');
  };

  const call = (which, v) => {
    try {
      if (v.kind === 'parse') {
        return repr(which === 'real' ? parseNwcBudget(...v.args) : naiveParse(...v.args));
      }
      if (v.kind === 'spend') {
        return repr(which === 'real' ? spendableSats(...v.args) : naiveSpendable(...v.args));
      }
      // A kind with no naive() is not a pass — comparing two absences is how a
      // whole section comes to sit green having been proved against nothing.
      throw new Error(`no naive() implementation for kind "${v.kind}"`);
    } catch (e) {
      // A wrong implementation is allowed to throw where the real one returns.
      // That still counts as differing — it is the loudest way to be wrong.
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

// lib/util.ts is deliberately NOT scanned by scripts/import-free.mjs: that scan
// rejects type-only relative imports on purpose, and util.ts has one. Type-only
// imports are erased by type stripping, so the module loads under plain Node,
// which is all this script needs. check:vts and check:art import it the same
// way and do not scan it either.

if (failures) {
  console.error(`\n${failures} NWC budget check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll NWC budget checks passed.');
