// The NIP-47 error classification, split out of `nwc.ts` so it can be pinned.
//
// `nwc.ts` imports `../storage` (localStorage) and so cannot load under
// `node --experimental-strip-types`, which is how every other `check:*` target
// exercises the REAL shipping code instead of a copy. This module imports the
// SDK and nothing else: a bare npm specifier resolves fine under plain Node —
// it is extensionless relative imports and browser globals that don't. So
// `scripts/check-nwcerror.mjs` can pin the real dispatch against real SDK error
// instances.
//
// The dispatch is the part worth pinning, not the table it feeds.
// `Nip47ReplyTimeoutError` and `Nip47PublishTimeoutError` both extend
// `Nip47TimeoutError`, and they mean OPPOSITE things — one says the request was
// published and the wallet may have paid, the other says it never left. Match
// the parent and they silently collapse into one answer, which is a money bug
// in the direction that cannot be undone. Extracting a "pure mapping" while
// leaving the `instanceof` behind in `nwc.ts` would have pinned the half that
// was never going to break.
//
// It deliberately does NOT go in `lib/util.ts`, which carries only a type-only
// import: an SDK dependency there would reach every component that renders a
// value split.

import { nwc } from '@getalby/sdk';

/**
 * Thrown when the wallet REFUSED the request instead of executing it.
 *
 * Load-bearing as a *type*, not just a message: nothing left the wallet, so the
 * caller may safely retry the leg by another route. `boost.ts` keys arm one of
 * its keysend→LNURL retry off `instanceof` this. Flattening it back into a
 * plain Error (as this code used to) makes a wallet that can't keysend
 * indistinguishable from a routing failure that may already have paid — and the
 * fallback would then be a double-pay.
 *
 * Three NIP-47 codes qualify, and they qualify for one reason: each is the
 * wallet answering a question about PERMISSION or CAPABILITY, which it can only
 * answer before it tries to pay.
 *
 * - `NOT_IMPLEMENTED` — the wallet does not implement `pay_keysend` at all.
 * - `UNAUTHORIZED`    — this connection has no wallet, or no rights, for it.
 * - `RESTRICTED`      — this connection is not permitted to run this method.
 *
 * The last two are not theoretical. A NIP-47 connection carries a per-METHOD
 * scope list (Alby's per-app connections are the common case), so a connection
 * granted `pay_invoice` and not `pay_keysend` is an ordinary setup — and the
 * LNURL retry then pays with the method it does hold. That is why the retry is
 * worth taking on these and not on `INSUFFICIENT_BALANCE`, `QUOTA_EXCEEDED` or
 * `RATE_LIMITED`: those also prove no payment moved, but they refuse the money
 * rather than the method, so the LNURL leg would be refused identically. They
 * stay untyped and fatal, which keeps this class meaning exactly one thing.
 *
 * Deliberately NOT `PAYMENT_FAILED`. That code is the wallet reporting on a
 * payment it DID attempt, and the code by itself cannot prove an HTLC did not
 * settle. Retrying on it is the double-pay this whole class exists to avoid.
 *
 * The retry gate has a second arm, `routingFailureProvesUnpaid`, and it is NOT
 * this class — keep the two apart. That one reads the failure REASON, and fires
 * only for a route search that finished and found nothing. A `PAYMENT_FAILED`
 * carrying such a reason is retried by that arm; a bare one is still retried by
 * neither. Widening THIS class to reach it would give a retry to every
 * `PAYMENT_FAILED` there is.
 */
export class NwcNotAttemptedError extends Error {
  /** The NIP-47 code, for logs — the branch is on the type, never on this. */
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'NwcNotAttemptedError';
    this.code = code;
  }
}

/**
 * The `NOT_IMPLEMENTED` arm of the above, kept as its own type because it means
 * something narrower and more durable: this WALLET cannot keysend at all, for
 * anybody, rather than this connection not being allowed to. `railCanKeysend`
 * asks the same question up front; this is the answer arriving late.
 *
 * A subclass, so every existing `instanceof NwcMethodUnsupportedError` site
 * keeps its exact meaning while the retry gate widens to the parent.
 */
export class NwcMethodUnsupportedError extends NwcNotAttemptedError {
  constructor(message: string) {
    super(message, 'NOT_IMPLEMENTED');
    this.name = 'NwcMethodUnsupportedError';
  }
}

/**
 * Thrown when the request reached the wallet's relay but no reply came back
 * inside the SDK's 60 s cap.
 *
 * **This is not a failure, and reporting it as one is a money bug.** The
 * request was published; the wallet may have executed the payment and simply
 * answered late, or not at all. Observed live against AlbyHub: every leg of a
 * boost showed ✗ in the modal while Alby pushed "Sent 10 sats" notifications
 * for each one and the recipient's wallet showed the sats arriving two minutes
 * later. A ✗ invites the user to boost again, and a re-boost repeats EVERY
 * leg — including the ones that already paid. Losing sats is recoverable;
 * sending them twice is not.
 *
 * The exact inverse of `NwcMethodUnsupportedError`, and the pair is worth
 * holding together: NOT_IMPLEMENTED is the wallet answering *instead of*
 * paying, so it proves nothing moved and the leg may be retried elsewhere. A
 * reply timeout proves nothing at all, so the leg must NOT be retried and must
 * NOT be called failed.
 *
 * Deliberately NOT raised for `Nip47PublishTimeoutError` — that one means the
 * request never reached the relay, so no payment can have happened and an
 * ordinary failure is the honest answer.
 */
export class NwcIndeterminateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NwcIndeterminateError';
  }
}

const NOT_IMPLEMENTED_MSG =
  'Wallet returned NOT_IMPLEMENTED — your NWC wallet may not support this payment type. Try Alby or Mutiny instead of an embedded node.';

const TIMEOUT_MSG =
  'Wallet did not answer in time — this payment may still have been sent. Check your wallet before boosting again.';

// The refusals that are about PERMISSION rather than about money. See
// NwcNotAttemptedError for why the money-side refusals are deliberately absent:
// they equally prove nothing was paid, but the retry they would license is
// refused identically, so typing them would only widen a class whose whole
// value is that it means one thing.
const REFUSAL_MSG: Record<string, string> = {
  UNAUTHORIZED:
    'Wallet returned UNAUTHORIZED — this NWC connection is not allowed to send this payment type.',
  RESTRICTED:
    'Wallet returned RESTRICTED — this NWC connection is not permitted to run this method.',
};

/** Map the SDK's typed errors into ours; pass anything else through. */
export function mapNwcError(e: unknown): unknown {
  if (e instanceof nwc.Nip47WalletError) {
    if (e.code === 'NOT_IMPLEMENTED') return new NwcMethodUnsupportedError(NOT_IMPLEMENTED_MSG);
    const refusal = e.code ? REFUSAL_MSG[e.code] : undefined;
    if (refusal) return new NwcNotAttemptedError(refusal, e.code as string);
  }
  // Reply timeout only. Nip47PublishTimeoutError extends the same parent but
  // means the opposite thing, so match the leaf class, not Nip47TimeoutError.
  if (e instanceof nwc.Nip47ReplyTimeoutError) {
    return new NwcIndeterminateError(TIMEOUT_MSG);
  }
  return e;
}

/**
 * True when a failure suggests the SOCKET is bad rather than the wallet
 * declining. A publish timeout means the request never reached the relay, which
 * is exactly what a dead or refused connection looks like.
 *
 * Deliberately does NOT include a reply timeout: that one means the request WAS
 * published and the wallet may have paid, so the socket is fine and the leg is
 * indeterminate — see `NwcIndeterminateError`.
 *
 * It lives here rather than in `nwc.ts`, where it was written, because
 * `failureBlamesDestination` needs the same answer and a second copy of a
 * money-path predicate is how two callers come to disagree about what a dead
 * connection is. `nwc.ts` imports it for its lease-discard decision.
 */
export function isSocketSuspect(e: unknown): boolean {
  if (e instanceof nwc.Nip47PublishTimeoutError) return true;
  const msg = e instanceof Error ? e.message : '';
  return /not connected|connection|websocket|socket closed/i.test(msg);
}

// Refusals about the payer's own money, quota or permissions. They prove no
// payment moved, and they are also — separately — no evidence at all about the
// recipient, which is the only question `failureBlamesDestination` asks.
//
// `INTERNAL` and `OTHER` are deliberately absent, even though both name a fault
// on the wallet's side. Wallets bucket a failed route search into them freely,
// so excluding them would mean the demotion never fires for exactly the wallets
// whose error reporting is worst — which is the bug, not a safe default. They
// fall through to the default below, and the cost of that being wrong is one
// address on LNURL for a few hours.
const PAYER_SIDE_CODES = new Set([
  'INSUFFICIENT_BALANCE',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'UNAUTHORIZED',
  'RESTRICTED',
  'NOT_IMPLEMENTED',
]);

/**
 * Whether a failed payment is evidence about the DESTINATION rather than about
 * the payer's wallet, connection or socket.
 *
 * `boost.ts` uses this to decide whether to remember that a lightning address's
 * keysend target is unreachable and send later legs to LNURL instead. It answers
 * a question about attribution ONLY — never about whether the sats moved, and
 * never about whether a leg may be retried. Those are `NwcIndeterminateError`
 * and `NwcNotAttemptedError`, and mixing this in with either is how a "we think
 * this address is broken" note becomes a licence to pay twice.
 *
 * The default is TRUE, and that direction is chosen, not left over. Being wrong
 * this way demotes one address to LNURL for a few hours, which costs the inline
 * boostagram and pays perfectly well — LNURL works on every rail and keysend
 * does not, the same non-regressive reading `LNURL_ONLY_DOMAINS` is held to.
 * Being wrong the other way is the bug this exists to fix: an unreachable node
 * that fails a leg of every boost, forever, with no path out.
 *
 * The timeout classes are collapsed here on purpose, which is the opposite of
 * the rule `mapNwcError` follows one function up. That rule exists because the
 * two answer "did this pay?" differently. This function asks "was the recipient
 * at fault?", and for that they answer the same: no. A wallet that never replied
 * and a request that never left the relay both leave the destination untested.
 */
export function failureBlamesDestination(e: unknown): boolean {
  if (e instanceof NwcNotAttemptedError) return false;
  if (e instanceof NwcIndeterminateError) return false;
  if (e instanceof nwc.Nip47TimeoutError) return false;
  if (isSocketSuspect(e)) return false;
  if (e instanceof nwc.Nip47WalletError && e.code && PAYER_SIDE_CODES.has(e.code)) return false;
  return true;
}

// The tokens a wallet uses to report a route search that FINISHED and found
// nothing. An allowlist, and it must stay one — the same rule `safeUrlAttr` is
// held to, for the same reason: a denylist of "reasons that might mean the
// payment landed" is unbounded and fails open, and failing open here is a
// second payment.
//
// `FAILURE_REASON_NO_ROUTE` is LND's terminal reason and is what the Alby
// browser extension prints (as `400: FAILURE_REASON_NO_ROUTE`). `NO_ROUTE`
// alone covers the wallets that pass the bare code through. The first entry is
// redundant against the second under today's boundary rule — `_` is a boundary
// — and is listed anyway, so that tightening the boundary can never silently
// stop matching the one string this was actually built from.
const TERMINAL_ROUTING_TOKENS = ['FAILURE_REASON_NO_ROUTE', 'NO_ROUTE'];

// A token boundary, not `\b` and not a bare `includes`. `readAttr` already cost
// this repo a substituted payee over `\b`, which treats `_` as a word character
// and `-` as a boundary — exactly backwards for these codes. Here the boundary
// is "not alphanumeric", so `FAILURE_REASON_NO_ROUTE` matches (`_` is a
// boundary) while `notarealNO_ROUTEthing` does not.
function hasToken(message: string, token: string): boolean {
  // Search AND index the same (uppercased) string. `toUpperCase()` is not
  // length-preserving in general — '\u00df' becomes 'SS' — so an offset taken
  // from the folded string and applied to the original slides the boundary test
  // onto the wrong characters. The test itself is case-insensitive, so nothing
  // is lost by reading the folded copy throughout.
  const haystack = message.toUpperCase();
  const i = haystack.indexOf(token);
  if (i < 0) return false;
  const before = i === 0 ? '' : haystack[i - 1];
  const after = haystack[i + token.length] ?? '';
  return !/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after);
}

/**
 * Whether a failed keysend may be paid again, RIGHT NOW, over LNURL — because
 * the wallet reported a completed route search that found nothing, so no HTLC
 * can have settled.
 *
 * This is the second arm of `payOne`'s retry gate, beside `NwcNotAttemptedError`
 * / `WeblnNotAttemptedError`, and it answers a different question from both of
 * its neighbours here. `failureBlamesDestination` asks *whose fault*;
 * `NwcIndeterminateError` says *we cannot know*; this one asks **did the sats
 * move**, and returns true only when the answer is a definite no.
 *
 * **It is a message heuristic, and that is a deliberate, narrow exception.** The
 * standing rule — stated in `NwcNotAttemptedError` above, in `webln.ts`, and in
 * `docs/money-boosts.md` — is that no wallet-side report proves an HTLC never
 * settled, so a failed keysend is fatal to its leg and only the ADDRESS is
 * demoted, one leg later. That rule stands for every other failure. A terminal
 * routing report is the one exception the payment protocol itself licenses: a
 * Lightning payment is atomic, a settled HTLC returns a preimage and is a
 * success, so a wallet that has finished searching and found no route has
 * already resolved every HTLC as failed. Nothing moved, and LNURL cannot
 * double-pay.
 *
 * It reads a message rather than a code because it has to. The reported case is
 * the Alby browser extension, which rejects `wl.keysend()` with a plain `Error`
 * — WebLN has no error codes at all. On the NWC rail the same text arrives as
 * the message of a `PAYMENT_FAILED` `Nip47WalletError`, so one predicate covers
 * both rails.
 *
 * The exclusions run FIRST and are the load-bearing half. A leg whose wallet
 * never answered must never reach the allowlist, whatever its message happens to
 * say: a reply timeout means the payment may have gone out, and that reading
 * outranks any text in it. Same for a dead socket, which leaves the destination
 * untested.
 *
 * Deliberately NOT in the allowlist, so nobody "completes" it:
 * - `FAILURE_REASON_TIMEOUT` / `FAILURE_REASON_ERROR` — neither is terminal
 *   about settlement.
 * - `INCORRECT_PAYMENT_DETAILS` — it does mean the destination rejected the
 *   HTLC, but that is a second claim with its own failure mode. Add it only with
 *   a real wallet's output in hand.
 * - `INSUFFICIENT_BALANCE`, `QUOTA_EXCEEDED`, `RATE_LIMITED` — these equally
 *   prove no payment moved, but the LNURL retry they would license is refused
 *   identically, so it buys nothing. Same reasoning `NwcNotAttemptedError` gives
 *   for keeping them out of its own class.
 */
export function routingFailureProvesUnpaid(e: unknown): boolean {
  // Exclusions first. Each of these says "we do not know what happened", and
  // that outranks anything the message claims.
  if (e instanceof NwcIndeterminateError) return false;
  // The parent, so BOTH leaves. This is the opposite of the rule `mapNwcError`
  // follows one function up, and for the same reason `failureBlamesDestination`
  // collapses them: a reply timeout may have paid, a publish timeout leaves a
  // suspect socket, and neither is a wallet reporting on a finished route
  // search.
  if (e instanceof nwc.Nip47TimeoutError) return false;
  if (isSocketSuspect(e)) return false;
  if (!(e instanceof Error)) return false;
  const message = e.message ?? '';
  if (!message) return false;
  return TERMINAL_ROUTING_TOKENS.some((t) => hasToken(message, t));
}

/**
 * Whether a failed keysend should demote the ADDRESS, sending later legs to
 * LNURL.
 *
 * The rule, and it is one sentence: **demote only what could not be rescued.**
 *
 * The demotion exists because a failed leg is money lost — an address whose
 * `.well-known/keysend` is published and correct while its node cannot be paid
 * failed a leg of every boost, forever, and a value block's fee recipients ride
 * on every show and every track. Redirecting the NEXT leg was the only repair
 * available.
 *
 * `routingFailureProvesUnpaid` changed that arithmetic. When it matches, the leg
 * is paid over LNURL immediately, so nothing is lost — and the demotion is no
 * longer a repair, only a cost. It is not a small one: an LNURL leg carries **no
 * TLV boostagram at all**, so `sender_id`, the podcast and episode, and the
 * `remote_feed_guid`/`remote_item_guid` correlation are all absent from the
 * wire, leaving a 255-character LUD-21 comment as the whole metadata channel.
 * Six hours of that, for every leg to that address, bought nothing.
 *
 * It is also frequently the wrong verdict. `FAILURE_REASON_NO_ROUTE` says the
 * PAYER could not find a path, which is as often the payer's own liquidity as
 * the recipient being unreachable — and on the WebLN rail there are no error
 * codes at all, so `failureBlamesDestination` reaches its default-TRUE arm and
 * files an Alby routing problem against a recipient whose keysend works.
 * Reported live: three `@getalby.com` addresses demoted, all paying fine over
 * LNURL, all silently stripped of their boostagram.
 *
 * What this deliberately does NOT do is stop demoting an unexplained failure.
 * That case has no rescue, so the original reasoning stands untouched: being
 * wrong there costs one address its inline boostagram for a few hours, and
 * being wrong the other way is a leg that fails on every boost forever.
 *
 * `refused` is passed in rather than tested here because it is a union with
 * `WeblnNotAttemptedError`, and this module must stay loadable under plain Node
 * — it cannot import a browser-only module. Same reason `payOne` computes it.
 */
export function shouldDemoteAddress(e: unknown, refused: boolean): boolean {
  // Nothing was sent and nothing is known about the recipient.
  if (refused) return false;
  // Rescued in place — see above. Demoting now would cost the boostagram and
  // buy nothing.
  if (routingFailureProvesUnpaid(e)) return false;
  return failureBlamesDestination(e);
}
