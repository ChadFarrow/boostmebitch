// Pins how a NIP-47 error is classified — the decision that says whether a
// failed-looking boost leg may be retried.
//
// Usage:
//   npm run check:nwcerror
//
// Run it after ANY edit to lib/v4v/nwc-errors.ts.
//
// Why this earns a check script: the three answers are not interchangeable, and
// two of the wrong pairings spend the user's money.
//
//   NOT_IMPLEMENTED   the wallet answered INSTEAD of paying. Nothing left the
//                     wallet, so the leg may safely be retried by another route
//                     — `boost.ts` keys its one permitted keysend→LNURL
//                     fallback off `instanceof NwcMethodUnsupportedError`.
//   reply timeout     the request was published and the wallet may have paid.
//                     Reporting this as a failure shows ✗, the user re-boosts,
//                     and EVERY leg pays again. Losing sats is recoverable;
//                     sending them twice is not. Observed live against AlbyHub:
//                     every leg showed ✗ while Alby pushed "Sent 10 sats" for
//                     each one.
//   publish timeout   the request never reached the relay, so no payment can
//                     have happened. An ordinary failure is the honest answer,
//                     and calling it indeterminate would tell the user not to
//                     retry a leg that genuinely never sent.
//
// THE DISPATCH IS THE FRAGILE PART, WHICH IS WHY THIS IMPORTS THE REAL MODULE.
// `Nip47ReplyTimeoutError` and `Nip47PublishTimeoutError` both extend
// `Nip47TimeoutError`, and neither sets a distinguishing `.name` or message —
// both report `name === 'Error'`. So the ONLY signal separating "may have paid"
// from "definitely didn't" is which leaf class was constructed, and a matcher
// written against the parent silently collapses them. Vectors 4 and 8 exist for
// exactly that, and the `naive()` control at the bottom is asserted to fail
// them: a check that only exercised a pure code→label table would pin the half
// that was never going to break.
//
// `--experimental-strip-types` lets this .mjs import the real .ts module.
// `nwc.ts` itself cannot be loaded that way — it imports `../storage`, an
// extensionless relative specifier that Node's resolver rejects, and touches
// localStorage — which is the whole reason this classification was split into
// `nwc-errors.ts`. That module imports the SDK and nothing else; a bare npm
// specifier resolves fine under plain Node. Keep it that way.

import { nwc } from '@getalby/sdk';
import {
  NwcIndeterminateError,
  NwcMethodUnsupportedError,
  mapNwcError,
} from '../lib/v4v/nwc-errors.ts';
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

const walletError = (code) => new nwc.Nip47WalletError('wallet said no', code);
const replyTimeout = () => new nwc.Nip47ReplyTimeoutError('no reply in 60s');
const publishTimeout = () => new nwc.Nip47PublishTimeoutError('never reached the relay');

// ---------------------------------------------------------------------------
section('The wallet answered instead of paying — retryable');
// ---------------------------------------------------------------------------
{
  const mapped = mapNwcError(walletError('NOT_IMPLEMENTED'));
  check('NOT_IMPLEMENTED becomes NwcMethodUnsupportedError',
    mapped instanceof NwcMethodUnsupportedError, true);
  // boost.ts branches on the TYPE, not the string. Flattening this to a plain
  // Error makes a wallet that can't keysend indistinguishable from a routing
  // failure that may already have paid, and the fallback becomes a double-pay.
  check('...and not a bare Error',
    Object.getPrototypeOf(mapped).constructor.name, 'NwcMethodUnsupportedError');
  check('...carrying an actionable message',
    /NOT_IMPLEMENTED/.test(mapped.message) && /wallet/i.test(mapped.message), true);

  // Only that one code. Every other wallet error is a real failure and must
  // reach the caller unchanged, or an arbitrary wallet complaint would license
  // the keysend→LNURL retry.
  for (const code of ['INSUFFICIENT_BALANCE', 'RATE_LIMITED', 'PAYMENT_FAILED', 'INTERNAL']) {
    const e = walletError(code);
    check(`a ${code} wallet error passes through untouched`, mapNwcError(e) === e, true);
  }
}

// ---------------------------------------------------------------------------
section('Reply timeout — may have paid, must NOT be reported as failure');
// ---------------------------------------------------------------------------
{
  const mapped = mapNwcError(replyTimeout());
  check('a reply timeout becomes NwcIndeterminateError',
    mapped instanceof NwcIndeterminateError, true);
  check('...and never NwcMethodUnsupportedError (that would license a retry)',
    mapped instanceof NwcMethodUnsupportedError, false);
  // The user is the one who has to not press the button again.
  check('...carrying a message that says to check the wallet first',
    /may still have been sent/i.test(mapped.message) && /check your wallet/i.test(mapped.message),
    true);
}

// ---------------------------------------------------------------------------
section('Publish timeout — nothing was sent, an ordinary failure is honest');
// ---------------------------------------------------------------------------
{
  const e = publishTimeout();
  const mapped = mapNwcError(e);
  // THE money-critical vector, and the one a parent-class matcher gets wrong.
  check('a publish timeout is passed through unchanged', mapped === e, true);
  check('...and is NOT indeterminate', mapped instanceof NwcIndeterminateError, false);
}

// ---------------------------------------------------------------------------
section('Why the two timeouts cannot be told apart by anything but their class');
// ---------------------------------------------------------------------------
{
  // Stated as assertions rather than prose, so an SDK upgrade that changes the
  // hierarchy fails here instead of silently changing what a boost reports.
  check('reply timeout extends the shared parent',
    replyTimeout() instanceof nwc.Nip47TimeoutError, true);
  check('publish timeout extends the same parent',
    publishTimeout() instanceof nwc.Nip47TimeoutError, true);
  check('neither carries a distinguishing name',
    replyTimeout().name === publishTimeout().name, true);
  check('a reply timeout is not a publish timeout',
    replyTimeout() instanceof nwc.Nip47PublishTimeoutError, false);
}

// ---------------------------------------------------------------------------
section('Anything else reaches the caller untouched');
// ---------------------------------------------------------------------------
{
  const plain = new Error('connection reset');
  check('a plain Error passes through', mapNwcError(plain) === plain, true);
  const typeErr = new TypeError('undefined is not a function');
  check('a TypeError passes through', mapNwcError(typeErr) === typeErr, true);
  // The SDK is not the only thing that can reject.
  check('a thrown string passes through', mapNwcError('nope') === 'nope', true);
  check('undefined passes through', mapNwcError(undefined) === undefined, true);
  check('null passes through', mapNwcError(null) === null, true);
}

// ---------------------------------------------------------------------------
section('Control — a parent-class matcher must fail the publish-timeout vector');
// ---------------------------------------------------------------------------
{
  // The plausible wrong version: match `Nip47TimeoutError`, the class both
  // timeouts share. It reads as more general and therefore safer, and it turns
  // "nothing was sent" into "may have been sent" for every publish failure.
  const naive = (e) => {
    if (e instanceof nwc.Nip47WalletError && e.code === 'NOT_IMPLEMENTED') {
      return new NwcMethodUnsupportedError('x');
    }
    if (e instanceof nwc.Nip47TimeoutError) return new NwcIndeterminateError('x');
    return e;
  };

  const pt = publishTimeout();
  check('(naive) it misreads a publish timeout as indeterminate',
    naive(pt) instanceof NwcIndeterminateError, true);
  check('(naive) so it disagrees with the shipping mapping',
    (naive(pt) instanceof NwcIndeterminateError) !== (mapNwcError(pt) instanceof NwcIndeterminateError),
    true);
  // It agrees everywhere else, which is exactly why the bug would survive a
  // review: one vector separates them.
  check('(naive) and agrees on the reply timeout, so only one vector catches it',
    naive(replyTimeout()) instanceof NwcIndeterminateError
      && mapNwcError(replyTimeout()) instanceof NwcIndeterminateError,
    true);
}

// ---------------------------------------------------------------------------
console.log('\nnwc-errors.ts stays loadable under plain Node');
// ---------------------------------------------------------------------------
{
  // The arrangement this whole script depends on: it imports the REAL module,
  // so the module must keep resolving under `node --experimental-strip-types`.
  // See scripts/import-free.mjs for why a type-only relative import counts.
  const problems = importFreeProblems('lib/v4v/nwc-errors.ts', { allowBare: true });
  if (problems.length) { explainImportFree('lib/v4v/nwc-errors.ts', problems); failures += problems.length; }
  else console.log('  ok    lib/v4v/nwc-errors.ts has no imports that plain Node cannot resolve');
}

if (failures) {
  console.error(`\n${failures} NWC error-mapping check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll NWC error-mapping checks passed.');
