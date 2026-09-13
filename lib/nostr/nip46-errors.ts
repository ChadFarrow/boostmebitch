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

// ── How BIG a NIP-46 request may be ────────────────────────────────────────
//
// A SECOND FAULT THAT WEARS THE FIRST ONE'S FACE. Everything above tells a
// signer's answer from a local throw. This tells one local throw from every
// other one, and it exists because the account menu accused the signer of being
// gone over a request that never left the browser.
//
// WHAT HAPPENS. nostr-tools 2.19.4 `sendRequest` builds the plaintext
// `JSON.stringify({ id, method, params })` and hands it to NIP-44 `encrypt`.
// NIP-44 v2 caps a plaintext at 65535 bytes and nostr-tools enforces it in
// `writeU16BE`: over that it throws `Error("invalid plaintext size: must be
// between 1 and 65535 bytes")`, synchronously, inside `sendRequest`'s own
// `try`, which rejects the call with that `Error`. No kind:24133 is published,
// no relay is contacted and the signer is never told anything.
//
// `trackBunkerCall` in ./bunker.ts then read that `Error` as "a local throw we
// did not author", marked the transport stale, and the account menu said
// *"Signer disconnected — your iPhone may have suspended the relay link."* over
// a link that had not been used. Reported from an iPhone, on Clave AND on
// Primal — which is the tell, because the throw is on THIS side of the wire and
// no signer can change it.
//
// WHY ONLY FOLLOWING HITS IT. Every other event this app signs is small: a
// boost note, a favourites list, a mute list, a profile. A NIP-02 kind:3 is the
// user's whole follow list in one event, at 77 request-bytes per followed
// pubkey, so the ceiling is **849 follows** with an empty `content` (836 with a
// 1 KB legacy relay list in it). Under that, following works; over it, no
// remote signer can sign a kind:3 for that user at all, and the app's job is to
// say so rather than to blame the phone.

/**
 * NIP-44 v2's plaintext ceiling, which is what bounds a NIP-46 request.
 *
 * Not a nostr-tools number and not ours: NIP-44 encodes the unpadded length as
 * a big-endian **u16**, so 65535 is the largest value that can be written at
 * all. A signer speaking the same spec has the identical limit on its reply.
 */
export const NIP46_MAX_REQUEST_BYTES = 65535;

/**
 * The exact plaintext `sendRequest` will encrypt, in BYTES.
 *
 * THE PARAMS ARE ALREADY STRINGS, and that is the whole subtlety. NIP-46 passes
 * a signing template as `params: [JSON.stringify(template)]` — a JSON document
 * nested inside another as a STRING — so every `"` in the event is re-escaped
 * as `\"` on the way in. Measuring the event instead of the request understates
 * it by ~5.6% on a kind:3 (62,033 → 65,484 bytes at 849 follows), which is a
 * real band of follow counts that looks fine and throws. `naiveSize` in
 * `scripts/check-nip46-errors.mjs` is exactly that mistake, replayed.
 *
 * BYTES, NEVER `.length`. The cap is on encoded UTF-8, so one emoji in a
 * profile's `content` is four of these and one of those.
 *
 * THE `id` IS MEASURED AS EMPTY ON PURPOSE, so this UNDER-estimates by the 8-20
 * bytes of `${idPrefix}-${serial}` that nostr-tools adds. That direction is the
 * safe one: this predicate must never refuse a request that would have gone
 * through, and anything inside that margin is still caught — it reaches the
 * library, throws, and `isRequestTooLarge` below recognises it. The two paths
 * end at the same error, so the margin costs nothing.
 */
export function nip46RequestBytes(method: string, params: readonly string[]): number {
  const plaintext = JSON.stringify({ id: '', method, params });
  return new TextEncoder().encode(plaintext).length;
}

/** Can this request be sent at all? See {@link nip46RequestBytes}. */
export function nip46RequestFits(method: string, params: readonly string[]): boolean {
  return nip46RequestBytes(method, params) <= NIP46_MAX_REQUEST_BYTES;
}

/**
 * Is this rejection nostr-tools refusing to ENCRYPT what we asked it to send?
 *
 * The backstop for the margin `nip46RequestBytes` leaves, and for any other
 * caller that reaches the library without being measured first.
 *
 * AN `Error`, NEVER A BARE STRING, on the same discriminator the rest of this
 * file rests on: this throw is raised in our own process, so a matching string
 * off the wire is a signer quoting a sentence at us, not this fault.
 *
 * ANCHORED ON THE WHOLE PHRASE. `unpad` throws `"invalid padding"` for an
 * oversized payload arriving the other way, which is a different fault with a
 * different fix, and a relay refusing a large event answers in its own words —
 * that one IS about the transport and must keep marking it stale. Never widen
 * this to `/size/`, `/too large/` or `/invalid/`.
 */
export function isRequestTooLarge(e: unknown): boolean {
  return e instanceof Error && /invalid plaintext size/i.test(e.message);
}
