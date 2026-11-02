// Is a NIP-46 rejection the signer saying "not yet", or the signer saying "no"?
//
// Pinned by `npm run check:nip46error`. Read this before editing it.
//
// WHY THIS EXISTS. Clave (the iOS signer, see ./clave.ts) used to answer a
// request it was holding for its user with an ERROR — `permission denied` — and
// then, once the user tapped approve, send the REAL result on the SAME request
// id. nostr-tools 2.19.4 settles on the first response it sees, so the caller
// got a rejection and the signed event was delivered to a handler already gone.
// `lib/nostr/bunker.ts` re-issues the call on this predicate instead. Clave
// stopped doing that in `dc59364` (2026-06-14) and now sends nothing until the
// user acts, but other signers still answer that way, so the predicate stays.
//
// A SECOND SOURCE OF THESE ANSWERS IS NOT THE PAIRED SIGNER AT ALL: another app
// holding the same key, answering a client it was never paired with. That is
// what `holdErrorsForResult` below is for, and it runs BEFORE this predicate
// ever sees an answer.
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
 * of that file** — but NOT FROM CLAVE, which is what the report that supplied it
 * concluded. The modal rendered *"no permission"* in magenta while Clave's own
 * Recent Activity listed the same `get_public_key` twice with a green tick: two
 * signer apps answering one request. Clave's source has never sent the string;
 * Amber sends it, verbatim, to any client it has no permission row for. It stays
 * on the list because with only such an app answering, the call should still
 * reach the approval loop and its Stop-waiting control rather than fail outright
 * — and since `holdErrorsForResult`, it only gets here when no result arrived in
 * the grace window. When a signer produces a phrasing that is not here, add the
 * observed string, never loosen an existing pattern into a token that would
 * have caught it.
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

// ── TWO SIGNER APPS, ONE KEY: a result beats an error on the same id ───────
//
// A NIP-46 request is addressed to the user's PUBKEY. Every signer app that
// holds that key and listens on the relay sees it, and each answers in its own
// way. The one that has never been paired with this client answers with an
// ERROR — Amber writes `BunkerResponse(id, "", "no permission")` for any client
// it has no permission row for (`EventNotificationConsumer.kt`) — while the
// signer the user actually paired answers with the RESULT.
//
// nostr-tools 2.19.4 settles a request on the FIRST answer for its id and then
// runs `delete listeners[id]` (`lib/esm/nip46.js`, read in node_modules). So
// whichever app is faster decides the call. Reported from an iPhone on
// 2026-11-01: a brand-new "Sign in with Clave" pairing, Amber on the same
// user's Android phone listening on the same two relays, and the account menu
// on "Waiting for you to approve in your signer (asked 5×) — Request: reading
// your public key" while Clave answered every one of those requests within a
// second. Amber was faster each time; `isApprovalPending` read its `no
// permission` as "queued for the user" and `withApprovalWait` asked again, into
// the same race. The relays' stored kind:24133 traffic showed two answers per
// request from the one key — a 176-character error and a 220-character result.
//
// THE RULE, AND WHY IT IS SAFE: every program that can author with this key
// produces the SAME correct result — the same pubkey, a valid signature by the
// same key, the same plaintext. An error is the only kind of answer that
// describes the RESPONDER's own state (its pairings, its permissions), so it is
// the only kind that can be wrong about this client. A result therefore beats
// an error on the same id; an error waits `NIP46_ERROR_GRACE_MS` for one.
//
// `no permission` WAS ONCE ATTRIBUTED TO CLAVE, and that was this same race.
// Clave's source (`Shared/LightSigner.swift`) has never sent that string, and
// since `dc59364` it sends no "not yet" answer at all. See docs/signers.md.

/** One entry in nostr-tools 2.19.4's `listeners` table — what `sendRequest`
 *  stores per request id and the subscription handler settles. */
export type Nip46Listener = {
  resolve: (result: string) => void;
  reject: (error: unknown) => void;
};

/** The two timer calls the hold needs, injected so the check script can drive
 *  a fake clock instead of waiting on a real one. */
export type HoldTimers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

/**
 * How long an error answer waits for a result on the same id.
 *
 * Clave answered about a second after Amber in the field traffic, and an
 * APNs-woken Clave answers an auto-allowed method in low single-digit seconds
 * (its own PR #93 measured a promptless probe at 1.2 s from a cold launch).
 * Five seconds covers that with room. THE COST is on a real refusal from the
 * only signer, which now reaches the caller this much later: a user who tapped
 * Deny in another app does not see it, and a short window that lets the
 * imposter win again would undo the whole fix.
 */
export const NIP46_ERROR_GRACE_MS = 5_000;

const DEFAULT_TIMERS: HoldTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const HELD_TABLES = new WeakSet<object>();

/** Has `holdErrorsForResult` already wrapped this table? Wrapping twice would
 *  stack two grace windows on one request. */
export function isHeldListenerTable(table: unknown): boolean {
  return typeof table === 'object' && table !== null && HELD_TABLES.has(table);
}

/**
 * Wrap nostr-tools' `listeners` table so that an ERROR answer does not end a
 * request while a RESULT may still arrive on the same id.
 *
 * It changes only what an entry's `reject` and the table's `delete` do; the
 * library's own dispatcher runs unchanged on top of it:
 *
 *   - `reject(error)` starts a grace timer and returns. A second error in the
 *     window does not restart it. When the window ends with no result, the
 *     caller's real `reject` runs.
 *   - `resolve(result)` settles at once, inside the window or before it.
 *   - `delete table[id]` is a no-op on an entry that has not settled. The
 *     library deletes right after it calls `reject` — the line this exists to
 *     neutralise — and also after an answer that carries NEITHER field, which
 *     would otherwise let one empty reply from any responder kill the request.
 *     ONLY A SETTLE REMOVES AN ENTRY.
 *
 * WHICH ERROR IS REPORTED when several arrive: the first, except that a final
 * answer replaces a "not yet" one. `isApprovalPending` is a claim that a later
 * answer is coming; a final refusal from another responder is the better guess
 * at what the user meant, and reporting it fails the call FAST instead of
 * sending `withApprovalWait` into a re-issue loop over a signer that said no.
 *
 * Entries that are not listener-shaped pass through untouched.
 */
export function holdErrorsForResult(
  table: Record<string, Nip46Listener>,
  graceMs: number = NIP46_ERROR_GRACE_MS,
  timers: HoldTimers = DEFAULT_TIMERS,
): Record<string, Nip46Listener> {
  if (isHeldListenerTable(table)) return table;
  // The entries THIS proxy built, and which of them have settled. `delete` keeps
  // only an entry that is both ours and unsettled, so a raw entry written
  // straight onto the target is never pinned in place.
  const ours = new WeakSet<Nip46Listener>();
  const settled = new WeakSet<Nip46Listener>();
  const held = new Proxy(table, {
    set(target, key, value) {
      if (typeof key !== 'string' || !isListener(value)) {
        Reflect.set(target, key, value);
        return true;
      }
      const real = value;
      let timer: unknown = null;
      let chosen: unknown;
      const entry: Nip46Listener = {
        resolve: (result) => {
          if (settled.has(entry)) return;
          settled.add(entry);
          if (timer !== null) timers.clear(timer);
          if (target[key] === entry) delete target[key];
          real.resolve(result);
        },
        reject: (error) => {
          if (settled.has(entry)) return;
          if (timer === null) {
            chosen = error;
            timer = timers.set(() => {
              if (settled.has(entry)) return;
              settled.add(entry);
              if (target[key] === entry) delete target[key];
              real.reject(chosen);
            }, graceMs);
            return;
          }
          if (isApprovalPending(chosen) && !isApprovalPending(error)) chosen = error;
        },
      };
      ours.add(entry);
      Reflect.set(target, key, entry);
      return true;
    },
    deleteProperty(target, key) {
      const entry: unknown = Reflect.get(target, key);
      if (isListener(entry) && ours.has(entry) && !settled.has(entry)) return true;
      Reflect.deleteProperty(target, key);
      return true;
    },
  });
  HELD_TABLES.add(held);
  return held;
}

function isListener(v: unknown): v is Nip46Listener {
  return typeof v === 'object' && v !== null
    && typeof (v as Nip46Listener).resolve === 'function'
    && typeof (v as Nip46Listener).reject === 'function';
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
