// Is a WebLN rejection a payment that is STILL IN FLIGHT? Import-free on
// purpose: `check:nwcerror` loads it under plain Node, and `webln.ts` reads it
// on every payment without pulling the NIP-47 engine into the first load.
//
// WebLN has no error codes, so this is the second (and only other) place the
// payment path reads a provider's MESSAGE — `routingFailureProvesUnpaid` is the
// first. It is an ALLOWLIST of the two markers Libre's wallet code writes, and
// it must stay one: matching "any timeout" or "any WebLN error" would turn a
// real failure into `?`, and a failure the user cannot see is one they cannot
// act on. See docs/money-boosts.md, "A WebLN payment that is still pending".
//
// THE TWO MARKERS, as they reach the page (read in
// ChadFarrow/libre-listener-wallet-monorepo at 468ac13b, and in the published
// `libre-wallet-embed-468ac13b….tgz`'s `dist/index.mjs`):
//
//   PAYMENT_TIMEOUT     the in-page embed. `payBolt11` throws the SDK's
//                       `PaymentTimeoutError` 90 s after `send_payment` was
//                       dispatched: `code === 'PAYMENT_TIMEOUT'` and a message
//                       that starts `[PAYMENT_TIMEOUT] Payment is still in
//                       flight`. The embed runs in the page's own JS context,
//                       so the object arrives whole — `code` included. Only
//                       `sendPayment` (an LNURL leg, the note stamp) can raise
//                       it: the embed's keysend resolves on dispatch.
//   SETTLEMENT_PENDING  the Libre browser extension. Its offscreen host rejects
//                       `Payment initiated but not yet settled; it may still
//                       complete. [SETTLEMENT_PENDING]`, and the in-page script
//                       rebuilds that as `new Error(message)` — only the text
//                       crosses `chrome.runtime`. Both `sendPayment` and
//                       `keysend` wait for settlement there, so BOTH can raise it.
//
// THE MATCH IS UPSTREAM'S OWN (`errorMatchesCode`, packages/shared): the `code`
// property, or the marker anywhere in the message, or in a bare string. Not
// narrower: the wallet keeps its spending-cap charge exactly when that matcher
// says pending, so a rejection this misses is one the wallet counts as spent and
// this app would call failed — the ✗ that invites a second payment. Never the
// class or constructor NAME: a bundler is free to rename it.

/** The machine-readable codes Libre writes into a still-pending payment's error. */
export const WEBLN_PENDING_CODES = ['PAYMENT_TIMEOUT', 'SETTLEMENT_PENDING'] as const;

/**
 * True when a WebLN provider's rejection says the payment was SENT and has not
 * settled yet — it may still complete, so it is neither a success nor a failure.
 */
export function weblnPaymentPending(e: unknown): boolean {
  if (e == null) return false;
  if (typeof e === 'string') return WEBLN_PENDING_CODES.some((c) => e.includes(c));
  if (typeof e !== 'object') return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code === 'string' && (WEBLN_PENDING_CODES as readonly string[]).includes(code)) return true;
  const message = (e as { message?: unknown }).message;
  return typeof message === 'string' && WEBLN_PENDING_CODES.some((c) => message.includes(c));
}
