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
import { CLAVE_RELAY } from './clave';
import { isApprovalPending } from './nip46-errors';

// Relays for the GENERATE flow's nostrconnect:// URI — TWO, and the count is a
// decision rather than what was left over.
//
// CLAVE_RELAY is not redundancy, it is a requirement. Clave's own
// docs/nip46-compatibility.md: a client without `switch_relays` — nostr-tools
// ~2.17, and CLAUDE.md pins us to exactly 2.19.4 — "cannot successfully
// complete nostrconnect pairing unless the URI already embeds
// wss://relay.powr.build". It is also the persistent proxy that fires the APNs
// wake, which is how a closed Clave answers at all. relay.nsec.app is the
// second because nsec.app and Amber-as-bunker both reach it.
//
// THIS SET USED TO CARRY damus, primal AND nos.lol, and removing them is the
// fix rather than a tidy-up. The reasoning for a wide set was ack redundancy
// across an iOS app switch. On iOS it buys the opposite: WebKit bug 302561 —
// on affected builds iCloud Private Relay allows only the FIRST WebSocket to a
// given host and port, recorded in ./clave.ts off Conduit's mobile-Safari QA
// baseline. All three of those share a host with DEFAULT_RELAYS, so the bunker's
// own SimplePool opens the SECOND socket to each and they may never connect —
// three relays in the URI that the signer can reach and this page cannot.
// relay.nsec.app and relay.powr.build are the two nothing else in the app
// connects to, which is exactly why they are the pair left standing.
//
// Conduit reach the same number from the other side: `pairRemoteSignerFromNostrConnect`
// (packages/core/src/protocol/remote-signer.ts) REJECTS a pairing with fewer
// than 2 or more than 3 relays. Two to three is the interoperable window; do not
// grow this list back without measuring what the extra relay answers on a phone.
//
// AND THIS IS NOT the "adding a relay is a latency decision" rule from
// docs/nostr.md. That rule is about broad scans, which resolve at AGGREGATE
// EOSE and therefore pay a silent relay its full ceiling. A NIP-46 exchange
// resolves on the first matching kind:24133 response, so a slow or silent relay
// here costs nothing. The cost here is the socket, not the wait.
const NOSTRCONNECT_RELAYS = [
  'wss://relay.nsec.app',
  CLAVE_RELAY,
];

/**
 * The NIP-46 methods the pairing URI ASKS FOR, granted once on the signer's
 * approval screen.
 *
 * OMITTING THIS WAS THE MOST EXPENSIVE LINE IN THE FILE. The URI used to carry
 * no `perms` at all, with a comment saying "bunker prompts per call" as though
 * that were a safety property. What it actually produced: Clave prompts per
 * call, so it answers `no permission` to the handshake's own `get_public_key`
 * and to every signature afterwards, and `withApprovalWait` below then waits out
 * a re-issue interval on each one. Sign-in, the boost note, the favorites
 * publish and the mute publish all paid it. The re-issue loop is the COST of
 * not sending this, not a feature that stands on its own.
 *
 * Measured against Conduit (github.com/Conduit-BTC/conduit-mono), whose iOS
 * Clave flow is tap → approve → switch back → signed in with no pause:
 * `CONDUIT_NIP46_PERMISSIONS` in packages/core/src/protocol/remote-signer.ts is
 * this list minus `nip04_encrypt`, passed straight to `createNostrConnectURI`.
 * nostr-tools 2.19.4 supports the field (`NostrConnectParams.perms`, joined with
 * commas into the query).
 *
 * `nip04_encrypt` is ours to add: `adaptToWindowNostr` exposes it, and the mute
 * list's private half must be re-encrypted in the cipher it was READ in, which
 * is NIP-04 for some writers (see docs/nostr.md).
 *
 * WHAT ASKING FOR THE DECRYPTS DOES AND DOES NOT CHANGE. It stops the signer
 * prompting for a decrypt. It does NOT widen `unattendedDecryptOk()`, which
 * governs which decrypts THIS APP issues before the user has touched anything
 * and still answers false for a bunker — nothing new is decrypted unasked. What
 * it fixes is the limitation recorded under `adaptToWindowNostr`: on a signer
 * that queues, the private mute half, the private favorites half and "Restore
 * from Nostr" die at the 10 s `withDecryptTimeout` cap, because a prompt cannot
 * be answered inside ten seconds. Granted, they return on the first ask.
 */
const NOSTRCONNECT_PERMS = [
  'get_public_key',
  'sign_event',
  'nip44_encrypt',
  'nip44_decrypt',
  'nip04_encrypt',
  'nip04_decrypt',
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
// THE GAPS ARE A SCHEDULE, NOT ONE NUMBER, and the shape carries the argument.
// A single 8 s interval was right about the long tail and wrong about the first
// ask: it is the whole of the delay a user feels between tapping Approve and
// this page reacting.
//
// Dense first, then wide. The first two asks land while the user is
// demonstrably standing at the signer — they just approved — so a short gap
// there costs nothing and saves the wait. After that the wide gap is right for
// the reason the original 8 s existed: each re-issue is a relay round trip AND,
// on a signer that did NOT queue the request, a fresh approval prompt, so a
// short interval spams the very screen we are waiting on. The last entry
// repeats for every attempt past the end of the list.
const BUNKER_APPROVAL_GAPS_MS = [2_500, 4_000, 8_000];

/** The gap before re-issue number `attempt` (1-based), holding the last value. */
function approvalGapFor(attempt: number): number {
  const i = Math.min(Math.max(attempt, 1), BUNKER_APPROVAL_GAPS_MS.length) - 1;
  return BUNKER_APPROVAL_GAPS_MS[i];
}
const BUNKER_APPROVAL_BUDGET_MS = 90_000;

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
 * The pause between two re-issues, which ends on the FIRST of three things.
 *
 * A PLAIN `setTimeout` IS THE WRONG TRIGGER ON iOS, and that is what this
 * exists for. Coming back to the tab is the one signal that says "they just
 * approved" — the approval happens in another app, so the switch back is part
 * of the act. Waiting out a timer instead means the page learns about it
 * whenever the clock says so, and on iOS the clock is not even running: Safari
 * throttles and suspends timers in a backgrounded tab, so the gap resumes on
 * return with an arbitrary remainder still to go. Measured as "I approve in
 * Clave, switch back, and it sits there".
 *
 * The three ends, and why each is needed:
 *   - the visibility wake, for an approval given in the signer app;
 *   - the timer, for one given without leaving the page — Clave signs from a
 *     Notification Service Extension, so a notification tap never fires a
 *     visibilitychange;
 *   - the generation, so `cancelBunkerApprovalWait` ends the loop at once
 *     rather than after the rest of the gap.
 *
 * ONE WAKE PER SLEEP. The listener is removed as soon as it fires, so a user
 * flapping between apps cannot turn one wait into a burst of re-issues at the
 * signer — the bound is one re-issue per attempt, whatever the tab does.
 *
 * Conduit's `waitForVisibleDocument`
 * (Conduit-BTC/conduit-mono, packages/core/src/protocol/interactive-signer.ts)
 * is the same primitive, reached from the other side: theirs gates a dispatch
 * on the page being visible, this ends a wait when it becomes visible.
 */
function waitBeforeReissue(ms: number, generation: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const doc = typeof document === 'undefined' ? null : document;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      doc?.removeEventListener('visibilitychange', onVisible);
      resolve();
    };
    const onVisible = () => { if (doc?.visibilityState === 'visible') finish(); };
    const timer = setTimeout(finish, ms);
    // The cancel arm. A poll rather than a listener set because the generation
    // is a plain counter several call sites bump; a second observable for it
    // would be one more thing to keep in step, and the resolution only has to
    // beat a human noticing that "Stop waiting" did nothing.
    const poll = setInterval(() => { if (approvalGeneration !== generation) finish(); }, 250);
    doc?.addEventListener('visibilitychange', onVisible);
  });
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
        // A CANCEL IS READ BEFORE THE BANNER GOES BACK UP, and the order is the
        // whole fix. "Stop waiting" can only land while this attempt is on the
        // wire — up to BUNKER_CALL_TIMEOUT_MS — and the check used to sit after
        // the sleep instead. So a cancelled wait re-armed the banner, slept,
        // and then left through the `finally`, whose generation guard refused
        // to clear what the loop had just set: nothing waiting, banner up,
        // until some later wait happened to end cleanly. Reported as the notice
        // sticking after Stop waiting.
        if (approvalGeneration !== generation) throw e;
        const gap = approvalGapFor(attempt);
        // No room for another attempt inside the budget — give the caller the
        // signer's own last answer rather than a message we made up.
        if (Date.now() - started + gap > BUNKER_APPROVAL_BUDGET_MS) throw e;
        activeApprovalWaits.add(token);
        setApprovalStage({ waiting: true, label, attempt });
        await waitBeforeReissue(gap, generation);
        if (approvalGeneration !== generation) throw e;
      }
    }
  } finally {
    activeApprovalWaits.delete(token);
    // THE SET IS THE AUTHORITY: the banner is up if and only if something is
    // waiting, so an empty set means clear it, whatever generation this loop
    // belongs to. The generation used to be a second condition here, guarding
    // against a superseded loop wiping a fresh one's state on its way out — but
    // a fresh wait that is waiting has its own token in the set, so the size
    // check already covers that, and one that has not reached its first
    // rejection yet has no state to wipe. Keeping both is what let a cancelled
    // loop leave the notice on screen with nothing behind it.
    if (activeApprovalWaits.size === 0) {
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
      const pk = await withApprovalWait(() => s.getPublicKey(), 'get_public_key');
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
  // Nothing shadows that memo any more. There used to be a Clave handoff record
  // beside it — which URI had already been handed to the app — because the
  // header row launched Clave itself and the modal had to know not to launch it
  // again. Reaching Clave is now an `<a href>` the user taps, so there is no
  // second launcher and nothing to keep in step.
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
 * One live listener on the session's pairing.
 *
 * `abandon` is the half that is easy to leave out and expensive to. A pairing
 * outlives its listener: the URI, the client key and the secret are memoized
 * and reused, while the SUBSCRIPTION behind them is replaced whenever the page
 * comes back from the signer app and cannot trust the socket it left with. The
 * replacement must not be added to the old one — see `abandon`'s own comment
 * for why closing is not the same as logging out, and NOSTRCONNECT_RELAYS for
 * why an abandoned socket is not free on iOS.
 */
export type NostrConnectAttempt = {
  uri: string;
  ready: Promise<BunkerAdapter>;
  /** Close this listener and destroy its sockets. Safe to call twice. */
  abandon: () => void;
};

/**
 * GENERATE flow. Creates a nostrconnect:// URI for the user to paste into
 * their remote signer; the returned promise resolves once the signer
 * connects back.
 *
 * The URI carries `perms` (NOSTRCONNECT_PERMS), so the methods this app uses
 * are granted once on the signer's approval screen rather than prompted for on
 * every call. It did not, once, and `withApprovalWait` is the machinery that
 * bought.
 *
 * On a retry within the same session (memo present), reuses the
 * previously generated clientSk + URI so the QR the user already
 * scanned remains valid — and the caller `abandon()`s the attempt it is
 * replacing first.
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
  // See the `url` field below for why this is the live origin rather than
  // BRAND.origin, and why the fallback exists at all.
  const origin = typeof window !== 'undefined' ? window.location.origin : BRAND.origin;
  const uri = createNostrConnectURI({
    clientPubkey,
    relays: NOSTRCONNECT_RELAYS,
    secret,
    // WHAT THE SIGNER IS BEING ASKED TO GRANT, once, on its approval screen.
    // See NOSTRCONNECT_PERMS: leaving this off is what made a queueing signer
    // answer `no permission` to every later call, and withApprovalWait the
    // price of it.
    perms: NOSTRCONNECT_PERMS,
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
    // WHO THE SIGNER SAYS IS ASKING. Without this Clave's approval sheet
    // headlines the raw client pubkey — `b6ce606e…fc96` — with our name below
    // it as an unverified self-claim. Conduit send it and their sheet reads
    // `shop.conduit.market`; screenshots of the two side by side are what
    // found this. It is the one field on that screen the user can check
    // against their own address bar, so omitting it makes the most important
    // decision in the flow harder for no reason.
    //
    // THE LIVE ORIGIN, NOT `BRAND.origin`, and that is deliberate. This is a
    // security prompt: it must describe where the request actually came from.
    // Printing the canonical domain while the user stands on a preview deploy
    // would be the app asserting something they cannot confirm — which is
    // exactly what the signer's own "unverified" label is warning about. The
    // cost is that a preview host earns its own entry in the signer's
    // connection list, which is the honest outcome rather than a bug.
    //
    // BRAND.origin is the fallback for a non-browser caller. `lib/brand.ts` is
    // still the only place a brand STRING may come from; a runtime origin is
    // not one.
    url: origin,
    // Same screen, same reason. A signer that has an icon renders it; one that
    // does not falls back to initials in a coloured circle, which is what ours
    // has been showing. Served from the origin above so the two always agree,
    // and it is the manifest's 192px PNG rather than the SVG because signers
    // render these in a native image view.
    image: `${origin}/icons/icon-192.png`,
  });
  nostrconnectMemo = { uri, clientSk, secret };
  storage.ncPending.set({ uri, clientSk: bytesToHex(clientSk), ts: Date.now() });
  return nostrconnectMemo;
}

export function startNostrConnect(
  onAuthUrl?: (url: string) => void,
): NostrConnectAttempt {
  const { uri, clientSk } = ensureNostrConnectMemo();
  const memoUri = uri;
  // Our pool, for the reason on `BunkerAdapter.pool`: this flow waits up to
  // NOSTRCONNECT_TIMEOUT_MS for a signer that may never scan the QR at all, so
  // the abandoned-transport case is the EXPECTED one here rather than the
  // exception. Built OUT HERE rather than inside the async body so `abandon`
  // below can reach it — that is the whole reason for the hoist.
  const pool = new SimplePool();
  let listener: BunkerSigner | null = null;
  let abandoned = false;
  // "This attempt WON." The transport it returned is the app's live signer from
  // that moment, so `abandon` must become a no-op — see its guard.
  let succeeded = false;
  const ready = (async () => {
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
    listener = signer;
    // A handshake that lands after `abandon` must take itself down rather than
    // hand back a live adapter. Its replacement owns the pairing now, and two
    // adapters on one pairing is what `abandon` exists to prevent.
    if (abandoned) {
      try { await signer.close(); } catch { /* ignore */ }
      try { pool.destroy(); } catch { /* ignore */ }
      throw new Error('This pairing attempt was replaced by a newer one.');
    }
    let pubkey: string;
    try {
      // THE HANDSHAKE'S OWN get_public_key NEEDS THE APPROVAL WAIT TOO, and
      // leaving it out is what made a paired Clave show as signed out. This was
      // a deliberate exclusion once, on the reasoning that the connect paths
      // own their own timeouts and a retry underneath one would stall sign-in.
      // A field report disproved it: without the retry sign-in does not stall,
      // it FAILS. Clave answers this call with an error string first and the
      // real key after the tap, exactly as it does a signature — the user's
      // phone listed `get_public_key` twice with a green tick while this page
      // showed the refusal.
      //
      // `withApprovalWait` keeps BUNKER_CALL_TIMEOUT_MS per attempt, so the
      // only behaviour added is the re-issue, and only on an approval-pending
      // answer. A terminal refusal still throws on the first response.
      pubkey = await withApprovalWait(() => signer.getPublicKey(), 'get_public_key');
    } catch (e) {
      try { await signer.close(); } catch { /* ignore */ }
      try { pool.destroy(); } catch { /* ignore */ }
      throw e;
    }
    nostrconnectMemo = null;
    storage.ncPending.clear();
    succeeded = true;
    return {
      inner: signer,
      pool,
      pubkey,
      nostrApi: adaptToWindowNostr(signer),
      uri,
      clientSkHex: bytesToHex(clientSk),
    };
  })();
  const abandon = () => {
    // A WINNING ATTEMPT CANNOT BE ABANDONED, and this guard is the difference
    // between tidying up and signing the user straight back out. Once `ready`
    // has resolved, this pool and this subscription ARE the app's live signer —
    // `finalizeBunkerLogin` installed them as `window.nostr`. A caller cannot
    // reasonably know that: the sign-in modal closes an attempt whenever it
    // starts another or the user dismisses it, and the winner is holding the
    // handle at exactly that moment.
    if (succeeded || abandoned) return;
    abandoned = true;
    // CLOSE, NEVER LOGOUT. `close()` ends this listener's kind:24133
    // subscription; `logout()` is a NIP-46 method that tells the signer to
    // forget the client — and the client key is SHARED with the replacement
    // listener, because the whole point is to keep the pairing the user already
    // approved. Logging out here would revoke the approval they just gave.
    // Conduit make the same distinction, in the same place, for the same
    // reason: "Never logout a superseded listener: its key may now belong to
    // the winning listener for this same pairing."
    try { void listener?.close(); } catch { /* ignore */ }
    try { pool.destroy(); } catch { /* ignore */ }
  };
  // `ready` rejects when the attempt is abandoned, and nothing may be left
  // holding that rejection: an abandoned attempt is routine, not a fault.
  ready.catch(() => { /* the caller's own handler reports what matters */ });
  return { uri, ready, abandon };
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
      const pk = await withApprovalWait(() => s.getPublicKey(), 'get_public_key');
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
