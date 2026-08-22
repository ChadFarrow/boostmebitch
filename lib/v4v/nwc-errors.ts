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
 * caller may safely retry the leg by another route. `boost.ts` keys its only
 * permitted keysend→LNURL fallback off `instanceof` this. Flattening it back
 * into a plain Error (as this code used to) makes a wallet that can't keysend
 * indistinguishable from a routing failure that may already have paid — and
 * the fallback would then be a double-pay.
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
 * payment it DID attempt, and no wallet-side report can prove an HTLC did not
 * settle. Retrying it is the double-pay this whole class exists to avoid.
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
