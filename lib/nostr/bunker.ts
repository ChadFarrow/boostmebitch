'use client';

// NIP-46 remote signer ("bunker") wrapper.
//
// Two flows:
//   1. PASTE flow ("Have URI"): user copies a bunker:// URI from their
//      remote signer (nsec.app, Amber-as-bunker, etc.) and pastes it here.
//      We parse it via parseBunkerInput, generate a client secret, and
//      connect.
//   2. GENERATE flow ("Generate URI"): we create a nostrconnect:// URI
//      with our client pubkey + a relay set, the user pastes it into
//      their signer, and the signer connects back to us.
//
// In both cases the result is a `BunkerSigner` from nostr-tools/nip46
// that exposes camelCase methods (signEvent, nip04Encrypt, etc.). We wrap
// it in a `BunkerSignerAdapter` whose shape matches `Window['nostr']` so
// the rest of the app — which already reads `window.nostr.signEvent` /
// `window.nostr.nip04.encrypt` — doesn't care which backend is active.
//
// Persisted state (lib/storage.ts:storage.bunker):
//   - uri:       the original bunker:// or nostrconnect:// URI
//   - clientSk:  hex-encoded client secret key. Persisting this is what
//                lets a refresh keep the same logical client identity, so
//                the bunker doesn't re-auth on every page load.

import {
  BunkerSigner,
  createNostrConnectURI,
  parseBunkerInput,
  type BunkerPointer,
} from 'nostr-tools/nip46';
import {
  generateSecretKey,
  getPublicKey,
  SimplePool,
  type Event,
  type EventTemplate,
} from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { storage } from '../storage';
import { BRAND } from '../brand';
import { CLAVE_RELAY, clearClaveHandoff } from './clave';
import { isApprovalPending } from './nip46-errors';

// Default relays for the GENERATE flow's nostrconnect:// URI. Multiple
// relays give the connect-ack redundancy: on same-device iOS, Safari
// suspends a backgrounded WebSocket while the user switches to Primal to
// approve, so a single-relay URI can lose the ack to a dead subscription
// and time out. (The older nostr-tools bug where one relay's CLOSED was
// fatal is fixed as of 2.23.x — subscribeMany.onclose now fires only when
// ALL relays close — so multi-relay is safe again.) This set mirrors the
// working MSP-2.0 config and is reachable by Primal, Clave, nsec.app, Amber.
// CLAVE_RELAY is not redundancy, it is a requirement, and it is unconditional
// for a structural reason rather than a lazy one. Clave's own
// docs/nip46-compatibility.md: a client without `switch_relays` — nostr-tools
// ~2.17, and CLAUDE.md pins us to exactly 2.19.4 — "cannot successfully
// complete nostrconnect pairing unless the URI already embeds
// wss://relay.powr.build". It is also the persistent proxy that fires the APNs
// wake, which is how a closed Clave answers at all.
//
// Unconditional because `startNostrConnect` memoizes ONE {uri, clientSk,
// secret} per session, shared by the iOS Clave button, the Android Amber button
// and the QR box. A Clave-only URI needs a second memo and a second code path,
// and the two would drift.
//
// AND THIS IS NOT the "adding a relay is a latency decision" rule from
// docs/nostr.md. That rule is about broad scans, which resolve at AGGREGATE
// EOSE and therefore pay a silent relay its full ceiling. A NIP-46 exchange
// resolves on the first matching kind:24133 response, so a slow or silent relay
// here costs nothing. Do not remove this by applying the wrong rule.
const NOSTRCONNECT_RELAYS = [
  'wss://relay.nsec.app',
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  CLAVE_RELAY,
];

const NOSTRCONNECT_TIMEOUT_MS = 120_000;

// How long any single bunker call (signEvent / nip04 / nip44) is allowed
// to wait before we conclude the relay subscription is dead. iOS PWA
// suspends backgrounded WebSockets, so a sign call after the user
// returns can hang indefinitely without this bound. 30s is well above
// the typical 1-3s round-trip but short enough that the user can
// recover via the "Reconnect" affordance instead of staring at a
// frozen UI.
const BUNKER_CALL_TIMEOUT_MS = 30_000;

// First-time `connect()` is the slow path — Primal/Clave/nsec.app may
// surface an auth_url that the user has to tap, switch apps, approve,
// then come back. nostr-tools' connect() has no timeout, so without
// this bound the UI is stuck on "Connecting…" forever if the user
// never approves, the relay drops, or iOS suspended Safari's WebSocket
// while the user was in the signer app. 90s gives a comfortable margin
// for the round-trip + manual approval.
const BUNKER_CONNECT_TIMEOUT_MS = 90_000;

// Short timeout for the automatic one-shot retry after a "subscription
// closed" failure. NIP-46 uses kind:24133 (ephemeral) events that relays
// are not supposed to store, so this retry only helps for transient
// network blips where the relay is still reachable. Keep it very short
// (3s) so we fail fast to the "go approve in Primal again" error state
// rather than leaving the user staring at "Connecting…" for 15+ seconds.
const BUNKER_RECONNECT_TIMEOUT_MS = 3_000;

// How long we keep re-issuing a request the signer has QUEUED for the user,
// and how long we wait between attempts. See withApprovalWait below.
//
// 90 s is BUNKER_CONNECT_TIMEOUT_MS' number on purpose: both answer the same
// question — how long to wait for a human who is in another app — and two
// different numbers for it would only invite the question of which is right.
// The honest worst case is 90 s + BUNKER_CALL_TIMEOUT_MS, because the last
// attempt can start just under the deadline and then time out; that lands at
// 120 s, which is clave-casa's own maxWaitMs reached from the other side.
//
// THE MONEY PATH ARGUES FOR THE LARGER BUDGET, NOT THE SMALLER. publishBoostNote
// signs AFTER the sats have moved (CLAUDE.md boost invariant 1), so a long wait
// costs a spinner beside a payment the user has already been told succeeded.
// Failing early costs the note outright: <PublishStatus> renders "Publish
// failed" with no retry control, and nothing re-tries a kind:1.
//
// 8 s rather than something snappier because each re-issue is a relay round
// trip AND, on a signer that did not queue the request, a fresh approval
// prompt. A short interval spams the very screen we are waiting on.
const BUNKER_APPROVAL_BUDGET_MS = 90_000;
const BUNKER_APPROVAL_RETRY_MS = 8_000;

// Module-level memo: the last clientSk we generated for a given pasted
// URI. The iOS Safari + Primal failure mode is that the user approves
// in Primal, but iOS suspended the WebSocket while they were in the
// other app, so the bunker's connect-ack is delivered to a dead
// subscription and lost. nostr-tools' setupSubscription uses limit:0
// with no `since`, so reconnecting can't replay the missed event.
//
// On retry within the same paste session we want to reuse the SAME
// clientSk so the bunker recognizes us as the already-approved client
// and acks immediately on the next connect request, rather than
// re-prompting the user to approve a brand-new client. Keyed on the
// sanitized URI so different pastes don't collide; cleared on
// successful connect or when the user signs out/clears the textarea.
const pendingClientSks = new Map<string, Uint8Array>();

// Module-level health flag + listener set. Set when any wrapped call
// times out or throws; cleared by restoreBunkerSigner on a successful
// reconnect. The account-menu reconnect banner subscribes via
// subscribeBunkerHealth.
let bunkerStale = false;
const healthListeners = new Set<(stale: boolean) => void>();

function setBunkerStale(stale: boolean) {
  if (bunkerStale === stale) return;
  bunkerStale = stale;
  for (const fn of healthListeners) {
    try { fn(stale); } catch { /* ignore */ }
  }
}

export function isBunkerStale(): boolean {
  return bunkerStale;
}

export function markBunkerStale(): void {
  setBunkerStale(true);
}

export function clearBunkerStale(): void {
  setBunkerStale(false);
}

export function subscribeBunkerHealth(fn: (stale: boolean) => void): () => void {
  healthListeners.add(fn);
  fn(bunkerStale);
  return () => { healthListeners.delete(fn); };
}

/**
 * "Your signer has the request and is waiting for you to approve it."
 *
 * A THIRD observable rather than a second meaning for bunkerStale, because the
 * two say opposite things: stale means the transport looks dead, this means it
 * demonstrably is not — the signer answered, it just answered "not yet". A
 * surface that shows the reconnect banner here would send the user to fix a
 * connection that is working, which is the exact fault
 * docs/signers.md's "A bunker that answers with an error is not a bunker that
 * is gone" was written against.
 *
 * It exists because withApprovalWait can otherwise sit for a minute and a half
 * with nothing on screen, and CLAUDE.md's rule is that a guard which withholds
 * must say so. `attempt` is 1-based and included so a surface can show progress
 * rather than a frozen sentence.
 */
export type BunkerApprovalStage = {
  waiting: boolean;
  /** The NIP-46 method being waited on, e.g. 'sign_event'. Null when idle. */
  label: string | null;
  /** Which re-issue we are on, 1-based. 0 when idle. */
  attempt: number;
};

let approvalStage: BunkerApprovalStage = { waiting: false, label: null, attempt: 0 };
const approvalListeners = new Set<(s: BunkerApprovalStage) => void>();
// Which waits are CURRENTLY sitting on an approval. A set rather than a boolean
// because calls overlap — a background nip44_encrypt can settle while a
// signEvent is still waiting — and a `finally` that cleared unconditionally
// would take the banner down out from under the call still waiting on it.
// Whichever wait most recently entered the waiting branch owns the label and
// the count; the banner goes away when the set empties.
const activeApprovalWaits = new Set<symbol>();
// Bumped by cancelBunkerApprovalWait; every loop captures it and gives up if it
// moves. A counter rather than a boolean so a cancel cannot leak into the NEXT
// wait — the user cancelling one signature must not pre-cancel the next.
let approvalGeneration = 0;

function setApprovalStage(next: BunkerApprovalStage) {
  if (approvalStage.waiting === next.waiting
    && approvalStage.label === next.label
    && approvalStage.attempt === next.attempt) return;
  approvalStage = next;
  for (const fn of approvalListeners) { try { fn(next); } catch { /* a listener must not break the wait */ } }
}

export function subscribeBunkerApproval(fn: (s: BunkerApprovalStage) => void): () => void {
  approvalListeners.add(fn);
  fn(approvalStage);
  return () => { approvalListeners.delete(fn); };
}

/**
 * Stop waiting, now — the escape hatch for the risk withApprovalWait accepts.
 *
 * NIP-46 standardises no error strings, so a signer that is refusing outright
 * may well phrase it as "permission denied" and be indistinguishable from one
 * that is queueing. That user would otherwise watch a spinner for the whole
 * budget. This makes it one tap, and the pending call rejects with the signer's
 * own last answer rather than a message we invented.
 */
export function cancelBunkerApprovalWait(): void {
  approvalGeneration += 1;
  activeApprovalWaits.clear();
  // Clear here rather than leaving it to the loop's `finally`. That branch is
  // guarded on the generation still matching — which cancelling has just made
  // false — so without this line the banner the user pressed "Stop waiting" on
  // would stay on screen until the next signature.
  setApprovalStage({ waiting: false, label: null, attempt: 0 });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Bunker ${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Did this rejection come back OFF THE WIRE, from the remote signer?
 *
 * nostr-tools 2.19.4, `lib/esm/nip46.js`: the subscription handler decrypts the
 * NIP-46 response, reads `{ id, result, error }`, and runs `handler.reject(error)`
 * — passing the signer's error STRING straight through, unwrapped. Every other
 * rejection on this path is an `Error` instance: our own `withTimeout` below,
 * `sendRequest`'s "this signer is not open anymore", and the `AggregateError`
 * that `Promise.any(pool.publish(...))` throws when no relay accepts. So
 * "not an Error" is an exact test for "the round trip completed".
 *
 * WHY IT MATTERS. An error RESPONSE is proof the link is alive. Treating it as a
 * dead transport put *"Signer disconnected — your iPhone may have suspended the
 * relay link."* in front of a user whose signer had just answered, correctly,
 * that it could not read a payload this app had sent in the wrong cipher. The
 * banner sent them to reconnect a connection that was working, and said nothing
 * about the real fault.
 *
 * VERSION-COUPLED, and it cannot be pinned by a `check:*` — this module imports
 * `nostr-tools` and touches browser globals, so it will not load under
 * `node --experimental-strip-types`. `nostr-tools` is pinned to exact 2.19.4 in
 * package.json (CLAUDE.md forbids bumping it for an unrelated reason); if that
 * ever moves, re-read `nip46.js` by hand. If a future version wraps `o.error`
 * in an `Error`, this silently reverts to the old behaviour rather than
 * breaking loudly.
 */
function isRemoteSignerError(e: unknown): boolean {
  return !(e instanceof Error);
}

/**
 * The one transient failure worth a second attempt: nostr-tools gave up on the
 * relay subscription before the handshake completed.
 *
 * CASE-INSENSITIVE, and that is a fix rather than defensiveness. nostr-tools
 * 2.19.4 throws `new Error("Subscription closed before connection was
 * established.")` — capital S — while both retry guards here tested
 * `String(e).includes('subscription closed')`. That never matched, so the
 * one-shot reconnect below has never fired since it was written, and the four
 * places the sign-in modal offers friendly copy for a dropped connection showed
 * the raw library sentence instead. The case that retry exists for is precisely
 * the one Clave and Amber hit: the OS suspends a backgrounded WebSocket while
 * the user is approving in the signer app.
 */
function isSubscriptionClosed(e: unknown): boolean {
  return /subscription closed/i.test(String(e));
}

// Wrap a bunker call with the timeout + stale-flag side effect.
//
// The flag means "the transport looks dead, offer a reconnect" — so only a
// failure that is EVIDENCE of that may set it. A timeout and a local throw
// qualify; an answer from the signer is the opposite of evidence and clears it,
// exactly as a success does. An Error we did not author still sets it, which
// fails toward offering the reconnect — the right direction for a genuine
// disconnect.
//
// IT TAKES A FACTORY, NOT A PROMISE, and that is not a style choice. A promise
// handed in here is already on the wire and can only settle once, so
// withApprovalWait below — which has to RE-ISSUE — could not be built around
// it. Typed as `() => Promise<T>` so `npm run typecheck` catches the one
// mistake this shape invites: passing `signer.signEvent(t)` instead of
// `() => signer.signEvent(t)`, which would re-await a single settled rejection
// in a tight loop until the budget expired.
async function trackBunkerCall<T>(issue: () => Promise<T>, label: string): Promise<T> {
  try {
    const v = await withTimeout(issue(), BUNKER_CALL_TIMEOUT_MS, label);
    if (bunkerStale) setBunkerStale(false);
    return v;
  } catch (e) {
    if (isRemoteSignerError(e)) {
      if (bunkerStale) setBunkerStale(false);
    } else {
      setBunkerStale(true);
    }
    throw e;
  }
}

/**
 * Re-issue a request the signer has QUEUED for the user's approval.
 *
 * WHY THIS EXISTS. Clave (lib/nostr/clave.ts) does not hold a request open
 * while the user decides. It answers immediately with `permission denied`, and
 * then — once the user taps approve — sends the real result on the same request
 * id. nostr-tools 2.19.4 settles on the FIRST response, so the caller gets a
 * rejection and the signature is delivered to a handler that is already gone.
 * Pairing succeeds and every signature afterwards fails: the boost note, the
 * favorites publish, the mute publish, each on the first approval, each looking
 * like the signer refused.
 *
 * So we ask again, on a NEW request id, until the signer stops saying "not yet".
 * A new id rather than a second listen, because there is nothing left to listen
 * with: nostr-tools 2.19.4 `lib/esm/nip46.js` runs `delete listeners[id]`
 * immediately after `handler.reject(error)` (read in node_modules, not
 * inferred), so the real result arriving later on that id is dropped by the
 * dispatcher before anything of ours could see it. `sendRequest` allocates
 * `${idPrefix}-${++serial}` per call, so each re-issue is a fresh kind:24133
 * the signer treats as a new request.
 *
 * RE-ISSUING IS SAFE HERE, and the reason is a property of THIS repo rather
 * than of NIP-46: every publisher stamps `created_at` into the template before
 * calling `signAndPublish` (lib/nostr/publish.ts), so a re-signed template is a
 * byte-identical event, not a second one. If a caller ever lets the signer pick
 * `created_at`, that stops being true and this wrapper has to come off
 * `signEvent`. There is also never a first signature to duplicate: we only
 * re-issue after a rejection.
 *
 * `isApprovalPending` is the whole gate and it fails closed on anything that is
 * not a bare string off the wire — see lib/nostr/nip46-errors.ts. A timeout or a
 * dead transport is an `Error`, is never approval-pending, and propagates
 * immediately, so the reconnect banner still fires for a genuine disconnect.
 *
 * The budget is enforced as a DEADLINE CHECK BEFORE THE NEXT ATTEMPT, never as
 * an outer race. A race would reject while a request is still in flight, and
 * the signer would then deliver a real signature that nobody consumes.
 *
 * THE RISK IT ACCEPTS, so it is not rediscovered as a bug: NIP-46 standardises
 * no error strings, so a signer REFUSING outright may phrase it identically and
 * now waits the full budget instead of failing fast. That is what
 * `subscribeBunkerApproval` and `cancelBunkerApprovalWait` are for; narrowing
 * the patterns instead would risk missing the string this exists for.
 */
async function withApprovalWait<T>(issue: () => Promise<T>, label: string): Promise<T> {
  const generation = approvalGeneration;
  const token = Symbol(label);
  const started = Date.now();
  let attempt = 0;
  try {
    for (;;) {
      attempt += 1;
      try {
        return await trackBunkerCall(issue, label);
      } catch (e) {
        if (!isApprovalPending(e)) throw e;
        // No room for another attempt inside the budget — give the caller the
        // signer's own last answer rather than a message we made up.
        if (Date.now() - started + BUNKER_APPROVAL_RETRY_MS > BUNKER_APPROVAL_BUDGET_MS) throw e;
        activeApprovalWaits.add(token);
        setApprovalStage({ waiting: true, label, attempt });
        await new Promise((r) => setTimeout(r, BUNKER_APPROVAL_RETRY_MS));
        if (approvalGeneration !== generation) throw e;
      }
    }
  } finally {
    activeApprovalWaits.delete(token);
    // Clear only when NOTHING is still waiting, and only from the current
    // generation. Two guards for two different mistakes: a call that never
    // waited at all must not take down a banner a concurrent one is sitting on,
    // and a loop that a cancel already superseded must not wipe a fresh one's
    // state on its way out.
    if (approvalGeneration === generation && activeApprovalWaits.size === 0) {
      setApprovalStage({ waiting: false, label: null, attempt: 0 });
    }
  }
}

export interface BunkerAdapter {
  /** Underlying nostr-tools BunkerSigner. Exposed for close() in disconnect. */
  inner: BunkerSigner;
  /**
   * The relay pool this connection runs on, which THIS module owns.
   *
   * `BunkerSigner` builds its own `SimplePool` when none is passed, and that
   * one is `private` — unreachable, and never closed by `inner.close()`, which
   * only ends the kind:24133 subscription. So the sockets outlived every
   * sign-out and every reconnect. Passing a pool in makes the lifetime ours:
   * `closeBunkerTransport` in lib/nostr/signer.ts destroys it alongside the
   * signer, and the connect paths below destroy it when a handshake fails.
   *
   * Never share this with the app's long-lived pool from lib/nostr/pool.ts —
   * it is destroyed outright, which would take the shared connections with it.
   */
  pool: SimplePool;
  /** Stable across calls — fetched once via inner.getPublicKey(). */
  pubkey: string;
  /** The window.nostr-shaped surface we polyfill. */
  nostrApi: NonNullable<Window['nostr']>;
  /** Original URI we connected with — re-used on reload for restore. */
  uri: string;
  /** Client secret key as hex; persisted alongside uri for restore. */
  clientSkHex: string;
}

/**
 * Wrap a connected BunkerSigner in the Window['nostr'] shape. Every call goes
 * through trackBunkerCall so timeouts / errors flip the stale flag for the
 * reconnect UI, and four of the six also go through withApprovalWait so a
 * signer that queues the request for its user is asked again rather than
 * reported as having refused.
 *
 * THE TWO DECRYPTS ARE DELIBERATELY LEFT OUT, and this is the inconsistency a
 * future reader will try to tidy away. Both of them already run inside a 10 s
 * cap that this module cannot see: `decryptWithTimeout` / `withDecryptTimeout`
 * in lib/nostr/signer.ts (NIP44_DECRYPT_TIMEOUT_MS), and lib/nostr/mutes.ts
 * puts the NIP-04 half through the same one. That cap is a `Promise.race`, so
 * it does not cancel what it outran. An approval loop underneath it would
 * therefore be unreachable — the outer race rejects at ten seconds with an
 * Error — AND would leave an orphaned loop firing re-issued requests at the
 * signer for another eighty, each one potentially a fresh prompt, with nobody
 * left to consume the answer. That is worse than not retrying at all.
 *
 * The cost is real and belongs on the record: on a signer that queues, a
 * private mute list, a private favorites half and a "Restore from Nostr" still
 * fail at ten seconds. Closing that means teaching `withDecryptTimeout` about
 * the bunker case FIRST, in signer.ts, and only then wrapping these two lines.
 *
 * The four encrypt/sign paths have no such outer cap — `wallet-backup.ts`,
 * `settings-backup.ts` and `favorites.ts` all await `requireNip44().encrypt`
 * bare — so the wait is reachable there. Re-issuing an encrypt produces a fresh
 * nonce, which is harmless because only one attempt ever returns and nothing in
 * this app compares ciphertexts.
 */
function adaptToWindowNostr(signer: BunkerSigner): NonNullable<Window['nostr']> {
  return {
    getPublicKey: () => withApprovalWait(() => signer.getPublicKey(), 'get_public_key'),
    signEvent: (template: EventTemplate): Promise<Event> =>
      withApprovalWait(() => signer.signEvent(template), 'sign_event') as Promise<Event>,
    nip04: {
      encrypt: (peerPubkey, plaintext) =>
        withApprovalWait(() => signer.nip04Encrypt(peerPubkey, plaintext), 'nip04_encrypt'),
      // No approval wait — capped at 10 s by withDecryptTimeout above this. See
      // the block comment.
      decrypt: (peerPubkey, ciphertext) =>
        trackBunkerCall(() => signer.nip04Decrypt(peerPubkey, ciphertext), 'nip04_decrypt'),
    },
    nip44: {
      encrypt: (peerPubkey, plaintext) =>
        withApprovalWait(() => signer.nip44Encrypt(peerPubkey, plaintext), 'nip44_encrypt'),
      // No approval wait — capped at 10 s by decryptWithTimeout above this.
      decrypt: (peerPubkey, ciphertext) =>
        trackBunkerCall(() => signer.nip44Decrypt(peerPubkey, ciphertext), 'nip44_decrypt'),
    },
  };
}

/**
 * Normalize a pasted bunker URI so we tolerate the cruft mobile clipboards
 * (and copy buttons in signers like Primal) tend to introduce:
 *   - leading/trailing whitespace, newlines from copy-paste UI
 *   - zero-width / BOM / NBSP characters that some "share sheet" flows
 *     prepend on iOS
 *   - uppercase hex in the bunker pubkey (NIP-46's reference regex is
 *     strict-lowercase; signers don't always agree)
 * Anything else is left intact so URL-encoded relay/secret values pass
 * through untouched.
 */
function sanitizeBunkerUri(input: string): string {
  // Strip whitespace + common invisible code points anywhere in the string.
  // \s covers ASCII + unicode whitespace; explicit escapes cover
  // ZWSP (U+200B), ZWNJ (U+200C), ZWJ (U+200D), BOM (U+FEFF), NBSP (U+00A0).
  let cleaned = input.replace(/[\s\u200B-\u200D\uFEFF\u00A0]/g, '');
  const m = cleaned.match(/^bunker:\/\/([0-9a-fA-F]{64})(.*)$/);
  if (m) {
    cleaned = `bunker://${m[1].toLowerCase()}${m[2]}`;
  }
  return cleaned;
}

/**
 * PASTE flow. Parses a bunker:// URI (or NIP-05 like name@example.com),
 * generates a fresh client secret, connects, and returns the adapter.
 *
 * `onAuthUrl` fires if the bunker requires the user to open an approval
 * URL during connect (Primal, nsec.app, Clave first-time flows).
 */
export async function connectBunkerFromUri(
  uri: string,
  onAuthUrl?: (url: string) => void,
): Promise<BunkerAdapter> {
  const cleaned = sanitizeBunkerUri(uri);
  if (!cleaned) {
    throw new Error('Empty bunker URI. Paste a `bunker://…` URI from your remote signer.');
  }
  const pointer = await parseBunkerInput(cleaned);
  if (!pointer) {
    throw new Error(
      'Could not parse bunker URI. Expected `bunker://<64-hex-pubkey>?relay=…` or a NIP-05 like `name@domain`. ' +
        'On Primal: Settings → Keys → Remote Signer → copy the connection string.',
    );
  }
  // Reuse a previous attempt's clientSk on retry so an already-approved
  // bunker doesn't re-prompt. See pendingClientSks comment above.
  let clientSk = pendingClientSks.get(cleaned);
  if (!clientSk) {
    clientSk = generateSecretKey();
    pendingClientSks.set(cleaned, clientSk);
  }
  // Stable narrowed references after the null/undefined checks above.
  // TypeScript doesn't carry control-flow narrowing into closures, so we
  // capture explicit consts here that the `attempt` function can safely use.
  const sk = clientSk;
  const bp = pointer;

  // Try to connect. If the relay subscription closes immediately (iOS
  // suspended the WebSocket while the user switched to Primal), wait 1s
  // and retry once with a shorter window. relay.primal.net buffers recent
  // ACKs, so the fresh subscription usually picks it up within a few
  // seconds. On any other error (timeout, parse failure) throw immediately.
  // **A FAILED handshake must take its transport down with it.** `fromBunker`
  // subscribes to the bunker relays the moment it is called, so an attempt that
  // then times out leaves a live subscription and up to four open sockets with
  // nothing holding a reference to them. The retry below made it two per call,
  // and the control that reaches this path is RECONNECT in the account menu —
  // pressed repeatedly on iOS, which suspends the socket. They accumulated for
  // the life of the tab until the relay refused the connection the reconnect
  // needed, which presents as the reconnect simply not working.
  async function attempt(timeoutMs: number): Promise<{ inner: BunkerSigner; pubkey: string; pool: SimplePool }> {
    const pool = new SimplePool();
    const s = BunkerSigner.fromBunker(sk, bp, { onauth: onAuthUrl, pool });
    try {
      await withTimeout(s.connect(), timeoutMs, 'connect');
      const pk = await withTimeout(s.getPublicKey(), BUNKER_CALL_TIMEOUT_MS, 'get_public_key');
      return { inner: s, pubkey: pk, pool };
    } catch (e) {
      // Both halves, in that order, and neither may throw over the real error:
      // `close()` ends the subscription, `destroy()` closes the sockets.
      try { await s.close(); } catch { /* ignore */ }
      try { pool.destroy(); } catch { /* ignore */ }
      throw e;
    }
  }

  let conn: { inner: BunkerSigner; pubkey: string; pool: SimplePool };
  try {
    conn = await attempt(BUNKER_CONNECT_TIMEOUT_MS);
  } catch (e) {
    if (!isSubscriptionClosed(e)) throw e;
    await new Promise<void>(r => setTimeout(r, 1_000));
    conn = await attempt(BUNKER_RECONNECT_TIMEOUT_MS);
  }

  pendingClientSks.delete(cleaned);
  return {
    inner: conn.inner,
    pool: conn.pool,
    pubkey: conn.pubkey,
    nostrApi: adaptToWindowNostr(conn.inner),
    uri: cleaned,
    clientSkHex: bytesToHex(sk),
  };
}

/** Drop any in-flight clientSk memos (paste flow + nostrconnect generate
 *  flow). Called when the user closes the OtherSignIn disclosure so a
 *  stale client identity doesn't outlive the session. */
export function clearPendingBunkerAttempts(): void {
  pendingClientSks.clear();
  nostrconnectMemo = null;
  storage.ncPending.clear();
  // The Clave handoff shadows that memo — it records which URI has already been
  // handed to the app. Dropping one without the other leaves the next session
  // believing it already launched for a URI that no longer exists, so the deep
  // link silently never fires.
  clearClaveHandoff();
}

/**
 * Does this look like something `connectBunkerFromUri` could take?
 *
 * A cheap SHAPE test, not a parse — `sanitizeBunkerUri` + `parseBunkerInput`
 * below do the real work and throw usefully. This exists so a clipboard read can
 * tell "the user copied their bunker URI" from "the user last copied a shopping
 * list", and decline to fire a connect attempt at the latter. Failing it costs
 * a hint; passing junk costs a real error message, so it is deliberately loose
 * on the two forms NIP-46 allows.
 */
export function looksLikeBunkerInput(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 2000) return false;
  if (/^bunker:\/\//i.test(t)) return true;
  // The NIP-05 form the paste box already accepts, e.g. name@example.com.
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(t);
}

// Session-scoped memo for the GENERATE flow. iOS Safari kills the
// fromURI subscription the moment the user backgrounds Safari to scan
// the QR with Primal — so the connect event Primal sends back can land
// while we have no listener, raising "subscription closed before
// connection was established." On retry we want the SAME clientSk +
// URI so:
//   1. The QR the user already scanned in Primal is still valid (no
//      need to re-scan).
//   2. Primal sees the second subscription as a re-listen for the same
//      pairing and (with relays that buffer recent events) can replay
//      the connect event we missed.
let nostrconnectMemo:
  | { uri: string; clientSk: Uint8Array; secret: string }
  | null = null;

/**
 * GENERATE flow. Creates a nostrconnect:// URI for the user to paste into
 * their remote signer; the returned promise resolves once the signer
 * connects back. No `perms` field — bunker prompts per call.
 *
 * On a retry within the same session (memo present), reuses the
 * previously generated clientSk + URI so the QR the user already
 * scanned remains valid.
 */
/**
 * The session's `nostrconnect://` URI, WITHOUT opening a subscription.
 *
 * `startNostrConnect` builds its `ready` eagerly — `BunkerSigner.fromURI`
 * subscribes inside the constructor path — so calling it merely to read the URI
 * leaves a live transport behind. That matters because a caller that only wants
 * to build a deep link would then have TWO subscriptions on one pairing, and
 * both would resolve on the single ack: two `finalizeBunkerLogin` calls, two
 * transports, and the second closing the first out from under it.
 *
 * The header's Clave row is exactly that caller — it needs the URI inside the
 * click, for the app-scheme activation, and wants the sign-in modal that mounts
 * afterwards to own the one subscription. So the memo is created here and both
 * paths read it.
 */
export function nostrConnectUri(): string {
  return ensureNostrConnectMemo().uri;
}

/** Is there a pairing this device was in the middle of, still inside its TTL?
 *  Read WITHOUT creating one — the sign-in modal uses it to decide whether to
 *  resume a handshake the page lost, and asking must not manufacture the thing
 *  it is asking about. */
export function hasPendingNostrConnect(): boolean {
  if (nostrconnectMemo) return true;
  const saved = storage.ncPending.get();
  return !!saved && Date.now() - saved.ts < NC_PENDING_TTL_MS;
}

// How long a pairing stays resumable across a page load. Deliberately longer
// than NOSTRCONNECT_TIMEOUT_MS: the promise giving up is not the same event as
// the pairing becoming unusable, and after a navigation the user needs time to
// come back and press "again". Same distinction AMBER_PENDING_TTL_MS draws.
const NC_PENDING_TTL_MS = 10 * 60_000;

function ensureNostrConnectMemo(): { uri: string; clientSk: Uint8Array; secret: string } {
  if (nostrconnectMemo) return nostrconnectMemo;
  // RESUME A PAIRING THIS TAB HAS LOST. Module state dies with the document,
  // and handing the URI to a signer app can navigate the tab — measured on an
  // iPhone, where Clave ended up holding an approved connection the page knew
  // nothing about. Reusing the persisted clientSk is what lets the signer
  // recognise an already-approved client and re-ack without a second approval;
  // minting a fresh one here would make that recovery impossible.
  const saved = storage.ncPending.get();
  if (saved && Date.now() - saved.ts < NC_PENDING_TTL_MS) {
    try {
      const restored = {
        uri: saved.uri,
        clientSk: hexToBytes(saved.clientSk),
        // The secret only matters for verifying the ack we already missed; the
        // URI carries the one the signer will echo, so an empty value here is
        // never compared against anything.
        secret: '',
      };
      nostrconnectMemo = restored;
      return restored;
    } catch {
      storage.ncPending.clear();
    }
  }
  const clientSk = generateSecretKey();
  const clientPubkey = getPublicKey(clientSk);
  // Random secret echoes back from the bunker's "connect" reply so we know
  // the connection paired correctly (NIP-46 requires this).
  const secret = bytesToHex(generateSecretKey()).slice(0, 16);
  const uri = createNostrConnectURI({
    clientPubkey,
    relays: NOSTRCONNECT_RELAYS,
    secret,
    // `wireName`, NOT `displayName`, and the reason is the encoder rather
    // than taste: createNostrConnectURI builds the query with
    // URLSearchParams, which writes a space as `+`. Amber percent-decodes and
    // leaves `+` alone, so "Boost Me Bitch" reached its approval screen as
    // "Boost+Me+Bitch" — measured on a Pixel 6, Amber 6.5.2. That screen is
    // where a user decides whether to trust this app, so the name has to be
    // right. `wireName` is the brand's no-spaces form and already serves the
    // same purpose in the boostagram `app_name` and the note `client` tag.
    //
    // It also keeps the two deploys apart in Amber's CONNECTION LIST, which
    // is not a bonus but the second half of the same measurement: Amber keys
    // a connection by this name, so while both deploys sent the identical
    // string it offered to REPLACE the existing connection — the live site's
    // signer link — when the other one signed in.
    name: BRAND.wireName,
  });
  nostrconnectMemo = { uri, clientSk, secret };
  storage.ncPending.set({ uri, clientSk: bytesToHex(clientSk), ts: Date.now() });
  return nostrconnectMemo;
}

export function startNostrConnect(
  onAuthUrl?: (url: string) => void,
): { uri: string; ready: Promise<BunkerAdapter> } {
  const { uri, clientSk } = ensureNostrConnectMemo();
  const memoUri = uri;
  const ready = (async () => {
    // Our pool, for the reason on `BunkerAdapter.pool`: this flow waits up to
    // NOSTRCONNECT_TIMEOUT_MS for a signer that may never scan the QR at all,
    // so the abandoned-transport case is the EXPECTED one here rather than the
    // exception.
    const pool = new SimplePool();
    let signer: BunkerSigner;
    try {
      signer = await BunkerSigner.fromURI(
        clientSk,
        memoUri,
        { onauth: onAuthUrl, pool },
        NOSTRCONNECT_TIMEOUT_MS,
      );
    } catch (e) {
      try { pool.destroy(); } catch { /* ignore */ }
      throw e;
    }
    let pubkey: string;
    try {
      pubkey = await withTimeout(
        signer.getPublicKey(),
        BUNKER_CALL_TIMEOUT_MS,
        'get_public_key',
      );
    } catch (e) {
      try { await signer.close(); } catch { /* ignore */ }
      try { pool.destroy(); } catch { /* ignore */ }
      throw e;
    }
    nostrconnectMemo = null;
    storage.ncPending.clear();
    return {
      inner: signer,
      pool,
      pubkey,
      nostrApi: adaptToWindowNostr(signer),
      uri,
      clientSkHex: bytesToHex(clientSk),
    };
  })();
  return { uri, ready };
}

/**
 * On page reload, rebuild the BunkerSigner from the persisted URI +
 * client secret. The signer's transport (NIP-04 DMs over a relay) is
 * stateless on the wire, so passing the same clientSk lets us resume
 * without a new auth round-trip.
 *
 * Returns null if there's nothing to restore. Throws if the persisted
 * URI was nostrconnect:// (we don't have the bunker pubkey to reconnect
 * to in that case — the bunker has to initiate). In practice users
 * paste a bunker:// or get one from the GENERATE flow's resolved
 * BunkerPointer; we persist the bunker:// form below.
 */
export async function restoreBunkerFromStorage(): Promise<BunkerAdapter | null> {
  const cached = storage.bunker.get();
  if (!cached) return null;
  let pointer: BunkerPointer | null = null;
  try {
    pointer = await parseBunkerInput(cached.uri);
  } catch {
    pointer = null;
  }
  if (!pointer) {
    // Likely a nostrconnect:// URI we couldn't restore; clear so the user
    // can reconnect manually.
    storage.bunker.clear();
    return null;
  }
  const clientSk = hexToBytes(cached.clientSk);
  const bp = pointer;
  // Same ownership and same teardown as `connectBunker`'s attempt above — and
  // this is the one the Reconnect button actually calls.
  async function attempt(timeoutMs: number): Promise<{ inner: BunkerSigner; pubkey: string; pool: SimplePool }> {
    const pool = new SimplePool();
    const s = BunkerSigner.fromBunker(clientSk, bp, { pool });
    try {
      await withTimeout(s.connect(), timeoutMs, 'reconnect');
      const pk = await withTimeout(s.getPublicKey(), BUNKER_CALL_TIMEOUT_MS, 'get_public_key');
      return { inner: s, pubkey: pk, pool };
    } catch (e) {
      try { await s.close(); } catch { /* ignore */ }
      try { pool.destroy(); } catch { /* ignore */ }
      throw e;
    }
  }
  let conn: { inner: BunkerSigner; pubkey: string; pool: SimplePool };
  try {
    conn = await attempt(BUNKER_CONNECT_TIMEOUT_MS);
  } catch (e) {
    if (!isSubscriptionClosed(e)) throw e;
    await new Promise<void>(r => setTimeout(r, 1_000));
    conn = await attempt(BUNKER_RECONNECT_TIMEOUT_MS);
  }
  return {
    inner: conn.inner,
    pool: conn.pool,
    pubkey: conn.pubkey,
    nostrApi: adaptToWindowNostr(conn.inner),
    uri: cached.uri,
    clientSkHex: cached.clientSk,
  };
}

/**
 * Convert the GENERATE flow's adapter (whose `uri` is nostrconnect://)
 * into a persistable bunker:// pointer once the signer has actually
 * connected. After connect we know the bunker's pubkey + relays from the
 * underlying signer, so we can build a bunker:// URI for restore.
 */
export function bunkerUriForRestore(adapter: BunkerAdapter): string {
  // If it's already bunker://, keep it.
  if (adapter.uri.startsWith('bunker://')) return adapter.uri;
  // Otherwise build one from the underlying signer's BunkerPointer.
  const bp = adapter.inner.bp;
  const params = new URLSearchParams();
  for (const r of bp.relays) params.append('relay', r);
  if (bp.secret) params.set('secret', bp.secret);
  return `bunker://${bp.pubkey}?${params.toString()}`;
}
