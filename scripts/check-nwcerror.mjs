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
//   UNAUTHORIZED      wallet, so the leg may safely be retried by another route
//   RESTRICTED        — `boost.ts` keys its only permitted keysend→LNURL
//                     fallback off `instanceof NwcNotAttemptedError`. All three
//                     answer a question about permission or capability, which a
//                     wallet can only answer before it tries to pay.
//   PAYMENT_FAILED    the wallet reporting on a payment it DID attempt. It reads
//                     final and is NOT in the class above, because no wallet-side
//                     report can prove an HTLC never settled — retrying it is a
//                     double-pay. `failureBlamesDestination` is what handles it
//                     instead: it demotes the ADDRESS so the NEXT leg goes to
//                     LNURL, which never re-pays anything.
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
  NwcNotAttemptedError,
  failureBlamesDestination,
  isSocketSuspect,
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

  check('...and is a NwcNotAttemptedError, which is what boost.ts branches on',
    mapped instanceof NwcNotAttemptedError, true);

  // THE money-critical vector of this section. Every other wallet error is a
  // real failure and must reach the caller unchanged, or an arbitrary wallet
  // complaint would license the keysend→LNURL retry. PAYMENT_FAILED is the one
  // that will keep being argued about: it reads like proof the sats stayed put,
  // and it is not — a wallet reporting failure while an HTLC settled would pay
  // that leg twice.
  for (const code of ['INSUFFICIENT_BALANCE', 'RATE_LIMITED', 'PAYMENT_FAILED', 'INTERNAL',
                      'QUOTA_EXCEEDED', 'OTHER', 'NOT_FOUND']) {
    const e = walletError(code);
    check(`a ${code} wallet error passes through untouched`, mapNwcError(e) === e, true);
    check(`...so a ${code} can never license the LNURL retry`,
      mapNwcError(e) instanceof NwcNotAttemptedError, false);
  }
}

// ---------------------------------------------------------------------------
section('The permission refusals — same proof, same retry, narrower type');
// ---------------------------------------------------------------------------
{
  // A NIP-47 connection carries a per-METHOD scope list, so a connection
  // granted pay_invoice and not pay_keysend is an ordinary Alby setup, not a
  // broken one. The wallet refuses the METHOD, which it can only do before
  // paying — so the LNURL leg pays with the method it does hold.
  for (const code of ['UNAUTHORIZED', 'RESTRICTED']) {
    const mapped = mapNwcError(walletError(code));
    check(`${code} becomes NwcNotAttemptedError`,
      mapped instanceof NwcNotAttemptedError, true);
    check(`...carrying ${code} for the log`, mapped.code, code);
    // It must NOT claim the wallet lacks keysend entirely — that is a durable
    // fact about the wallet and this is a fact about one connection's scopes.
    check('...and is not NwcMethodUnsupportedError',
      mapped instanceof NwcMethodUnsupportedError, false);
    check('...and is never indeterminate',
      mapped instanceof NwcIndeterminateError, false);
  }
  // The subclass relationship is the whole reason the widening is safe: every
  // pre-existing NwcMethodUnsupportedError site keeps its exact meaning.
  check('NOT_IMPLEMENTED still reports its own code',
    mapNwcError(walletError('NOT_IMPLEMENTED')).code, 'NOT_IMPLEMENTED');
  check('a method-unsupported error IS a not-attempted error',
    new NwcMethodUnsupportedError('x') instanceof NwcNotAttemptedError, true);
  check('...but not the reverse',
    new NwcNotAttemptedError('x', 'RESTRICTED') instanceof NwcMethodUnsupportedError, false);
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
section('isSocketSuspect — is the CONNECTION bad, or did the wallet decline?');
// ---------------------------------------------------------------------------
{
  // Moved here from nwc.ts so there is one definition: the lease-discard
  // decision and the attribution decision below must not drift apart about what
  // a dead connection is.
  check('a publish timeout is a suspect socket', isSocketSuspect(publishTimeout()), true);
  // The same leaf-class rule as mapNwcError, for the same money reason: a reply
  // timeout means the wallet HAS the request, so the socket is fine.
  check('a reply timeout is NOT', isSocketSuspect(replyTimeout()), false);
  check('a websocket message is', isSocketSuspect(new Error('socket closed')), true);
  check('a wallet refusal is not', isSocketSuspect(walletError('NOT_IMPLEMENTED')), false);
}

// ---------------------------------------------------------------------------
section('failureBlamesDestination — attribution, never a licence to re-pay');
// ---------------------------------------------------------------------------
{
  // boost.ts asks this to decide whether to remember that a lightning address's
  // keysend target does not pay, and route LATER legs to LNURL. It answers a
  // question about WHOSE fault, and nothing else. Getting it wrong costs one
  // address its inline boostagram for a few hours; getting it confused with
  // "may this leg be retried" costs a second payment, which is why the two live
  // in different functions with different vectors.
  //
  // `alsoNaive` marks a vector the wrong implementation below also happens to
  // get right — a property of that vector, never the default.
  const vectors = [
    // The reason this function exists. Podcast Index-shaped: a published, valid
    // .well-known/keysend whose node cannot actually be paid.
    { label: 'a wallet-reported PAYMENT_FAILED blames the destination',
      error: walletError('PAYMENT_FAILED'), expected: true, alsoNaive: true },
    { label: 'a bare routing error blames the destination',
      error: new Error('no route to destination'), expected: true, alsoNaive: true },
    // Wallets bucket a failed route search into these, so they must NOT be
    // excused as payer-side — see PAYER_SIDE_CODES.
    { label: 'an INTERNAL wallet error still blames the destination',
      error: walletError('INTERNAL'), expected: true, alsoNaive: true },
    { label: 'an OTHER wallet error still blames the destination',
      error: walletError('OTHER'), expected: true, alsoNaive: true },
    { label: 'a non-Error throw blames the destination',
      error: 'nope', expected: true, alsoNaive: true },

    // Everything below is about the payer. Blaming the recipient for these is
    // how one empty wallet demotes every address in the value block at once.
    { label: 'an empty wallet does not blame the destination',
      error: walletError('INSUFFICIENT_BALANCE'), expected: false },
    { label: 'a spent budget does not', error: walletError('QUOTA_EXCEEDED'), expected: false },
    { label: 'a rate limit does not', error: walletError('RATE_LIMITED'), expected: false },
    { label: 'a connection with no keysend scope does not',
      error: mapNwcError(walletError('RESTRICTED')), expected: false },
    { label: 'a wallet that cannot keysend at all does not',
      error: mapNwcError(walletError('NOT_IMPLEMENTED')), expected: false },
    // The destination was never tested in either timeout case, which is why
    // they are collapsed HERE and must never be collapsed in mapNwcError.
    // The one payer-side vector the wrong implementation also gets right: it is
    // the single case it was written around, which is exactly why the RAW reply
    // timeout below is here too — that one it misses.
    { label: 'a wallet that never answered does not (it may have paid)',
      error: mapNwcError(replyTimeout()), expected: false, alsoNaive: true },
    { label: 'a raw reply timeout does not either',
      error: replyTimeout(), expected: false },
    { label: 'a request that never reached the relay does not',
      error: publishTimeout(), expected: false },
    { label: 'a dead socket does not',
      error: new Error('websocket connection closed'), expected: false },
  ];

  // The plausible wrong version: "anything but an unanswered wallet is the
  // recipient's fault." It reads as the same idea and it demotes every address
  // in the block the moment the user's own wallet runs dry or loses its socket.
  const naive = (e) => !(e instanceof NwcIndeterminateError);

  for (const v of vectors) {
    check(v.label, failureBlamesDestination(v.error), v.expected);
    if (!v.alsoNaive) {
      check(`  (naive) disagrees on: ${v.label}`, naive(v.error) !== v.expected, true);
    }
  }
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
