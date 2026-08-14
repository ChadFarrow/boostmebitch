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
 * Thrown when the wallet answers a NIP-47 request with `NOT_IMPLEMENTED`.
 *
 * Load-bearing as a *type*, not just a message: the wallet returns this error
 * **instead of** executing the payment, so nothing left the wallet and the
 * caller may safely retry the leg by another route. `boost.ts` keys its one
 * permitted keysend→LNURL fallback off `instanceof` this. Flattening it back
 * into a plain Error (as this code used to) makes a wallet that can't keysend
 * indistinguishable from a routing failure that may already have paid — and
 * the fallback would then be a double-pay.
 */
export class NwcMethodUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
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

/** Map the SDK's typed errors into ours; pass anything else through. */
export function mapNwcError(e: unknown): unknown {
  if (e instanceof nwc.Nip47WalletError && e.code === 'NOT_IMPLEMENTED') {
    return new NwcMethodUnsupportedError(NOT_IMPLEMENTED_MSG);
  }
  // Reply timeout only. Nip47PublishTimeoutError extends the same parent but
  // means the opposite thing, so match the leaf class, not Nip47TimeoutError.
  if (e instanceof nwc.Nip47ReplyTimeoutError) {
    return new NwcIndeterminateError(TIMEOUT_MSG);
  }
  return e;
}
