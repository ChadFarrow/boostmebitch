// Is a NIP-46 rejection the signer saying "not yet", or the signer saying "no"?
//
// Pinned by `npm run check:nip46error`. Read this before editing it.
//
// WHY THIS EXISTS. Clave (the iOS signer, see ./clave.ts) does not hold a
// request open while the user approves it. It answers immediately with an
// ERROR — `permission denied` — and then, once the user taps approve, sends the
// REAL result on the SAME request id. nostr-tools 2.19.4 settles on the first
// response it sees, so the caller gets a rejection and the signed event is
// delivered to a handler that is already gone.
//
// Left alone, that is not a sign-in bug. Pairing succeeds; it is every
// SIGNATURE afterwards that fails — the boost note, the favorites publish, the
// mute publish — each on the first approval, each looking like the signer
// refused. `lib/nostr/bunker.ts` re-issues the call on this predicate instead.
//
// IT FAILS CLOSED ON ANYTHING THAT IS NOT A BARE STRING, and that is the load-
// bearing half rather than the regex list.
//
// nostr-tools 2.19.4 (`lib/esm/nip46.js`) decrypts the response, reads
// `{ id, result, error }` and calls `handler.reject(error)` — passing the
// signer's error string through UNWRAPPED. Every other rejection on that path
// is an `Error` instance: `bunker.ts`'s own `withTimeout`, `sendRequest`'s
// "this signer is not open anymore", and the `AggregateError` from
// `Promise.any(pool.publish(...))`. So "a bare string" is an exact test for
// "this came off the wire, from the signer" — the same discriminator
// `isRemoteSignerError` in `bunker.ts` already documents, and coupled to the
// same exact `2.19.4` pin. If that pin ever moves, re-read `nip46.js` by hand:
// a version that wraps `o.error` in an `Error` turns this predicate off
// silently rather than breaking loudly.
//
// OVER-MATCHING IS THE EXPENSIVE DIRECTION, so the list stays an allowlist of
// whole phrases. Under-matching costs a Clave user one failed publish they can
// repeat. Over-matching turns a DIFFERENT signer's terminal refusal — nsec.app
// or Amber-as-bunker answering "no" and meaning it — into a wait for an
// approval that is never coming, on a request the user is watching. So each
// pattern is a whole phrase a signer would only write when it means this. Never
// widen one to a bare /denied/, /error/ or /pending/: a short token like that
// matches inside sentences nobody wrote for us.
//
// NO IMPORTS AT ALL — `scripts/check-nip46-errors.mjs` imports this module for
// real under `node --experimental-strip-types`, which is what stops the check
// drifting from the shipping code. `bunker.ts` itself can never be checked that
// way: it imports `nostr-tools` and touches browser globals. A type-only
// relative import counts as an import here; see `scripts/import-free.mjs`.

/**
 * The phrasings that mean "queued, waiting for the human".
 *
 * Five came from Clave's own reference web client (DocNR/clave-casa,
 * `src/lib/signer.ts`), which lists them because Clave's answer has varied
 * across builds. Anchored to whole phrases on purpose; see the over-matching
 * note above.
 *
 * **`no permission` is the sixth, and it came off a real iPhone rather than out
 * of that file.** Clave answered a pairing's `get_public_key` with exactly that
 * string; the modal rendered *"no permission"* in magenta while Clave's own
 * Recent Activity listed the same call twice with a green tick. A list copied
 * from a vendor's client is a starting point, not the set — when a signer
 * produces a phrasing that is not here, the fix is to add the observed string,
 * never to loosen an existing pattern into a token that would have caught it.
 */
export const APPROVAL_PENDING_PATTERNS: readonly RegExp[] = [
  /permission denied/i,
  /permission not granted/i,
  /no permission/i,
  /not authorized/i,
  /awaiting approval/i,
  /queued for approval/i,
];

/**
 * May this rejection be re-issued, because the signer is still asking the user?
 *
 * True ONLY for a bare non-empty string that matches one of the patterns above.
 * An `Error` — a timeout, a closed transport, a publish failure — is never
 * approval-pending: it is evidence about the transport, not an answer from the
 * signer, and retrying it would paper over a genuine disconnect.
 *
 * The caller is `withApprovalWait` in `lib/nostr/bunker.ts`, which bounds the
 * total wait and re-issues the identical request. Re-issuing is safe only
 * because every publisher in this app stamps `created_at` into the template
 * itself before calling `signAndPublish` — a re-signed template is a
 * byte-identical event, not a second one.
 */
export function isApprovalPending(e: unknown): boolean {
  if (typeof e !== 'string') return false;
  const s = e.trim();
  if (!s) return false;
  return APPROVAL_PENDING_PATTERNS.some((re) => re.test(s));
}
