'use client';

// NIP-55 Amber signer (Android).
//
// Two ways a result can come back, and the app uses both:
//
//   CLIPBOARD (the original, still the default). Same-tab navigation to
//   Amber with NO callbackUrl — as an `intent:` URL carrying the NIP-55
//   parameters as extras, see buildSignerIntentUrl for why not `nostrsigner:`
//   directly. Per
//   NIP-55: "If you don't send a callback url, Signer Application will copy
//   the result to the clipboard." Returning to the page is then the USER's
//   job, which is what the capture-phase pointer/touch/key listeners below are
//   for — they are the load-bearing half of that design, not a fallback.
//
//   CALLBACK (new, `get_public_key` only). Amber navigates to a `callbackUrl`
//   with the result appended. That RELOADS the page, so the promise the caller
//   is awaiting dies with it; the request is parked in sessionStorage and the
//   result is picked up when the caller asks again.
//
// WHY BOTH, AND WHY THE CALLBACK IS NOT USED EVERYWHERE:
//
// The clipboard flow's premise — "Amber returns focus, the tab fires
// `visibilitychange`, we read the clipboard" — DOES NOT HOLD on a real device.
// Measured 2026-08-21 on a Pixel 6 (Android 17, Brave default, no Chrome):
// Brave dispatches the intent with LAUNCH_SINGLE_TASK, so Amber opens in its
// own task, and approving finishes that task and drops the user on the
// LAUNCHER. The tab never sees `visibilitychange`, the request never resolves,
// the caller retries, and the prompt comes straight back. Reproduced in an
// ordinary Brave tab as much as in the Trusted Web Activity, so it is not a
// packaging problem. A `callbackUrl` is what makes Amber come back at all.
//
// But a callback costs a page reload, and a reload is not free everywhere.
// `get_public_key` is the only request in this app with NO page state attached
// to it: it is user-initiated from a modal, its result feeds `completeSignIn`,
// and there is nothing on screen a reload destroys. Every other request has
// something to lose, and one of them has money on screen —
// `publishBoostNote` signs AFTER the sats have gone out, and the per-leg
// results it would destroy are the only record the user has of which
// recipients were paid. So the rule is:
//
//   A request may use `callbackUrl` only if losing every byte of page state
//   costs the user nothing. Today exactly one request qualifies.
//
// See RESUMABLE_TYPES below, and docs/signers.md for the rest of the reasoning.
//
// Trade-off worth knowing: each signEvent / nip04.* / nip44.* call shows the
// Amber prompt. Background-published events that the rest of the app debounces
// (favorites, mutes) will visibly switch to Amber. That's inherent to NIP-55.
//
// Manual paste is kept as a last-resort UI: if the clipboard read is denied
// (private mode, browser policy, no user gesture) the user can still paste
// the result by hand.

import { nip19, verifyEvent, type Event, type EventTemplate } from 'nostr-tools';
import {
  AMBER_CALLBACK_PATH,
  buildAmberCallbackUrl,
  buildSignerIntentUrl,
  looksLikeAmberResult,
  newAmberRequestId,
  amberRecordIsFresh,
  payloadSurvivesAmber,
  type AmberRequestType,
  type AmberUrlOptions,
} from './amber-callback-url';
import { escapeJsonForAmber } from './amber-safe-text';
// A VALUE import of lib/storage.ts from inside lib/nostr/ used to be a cycle
// (storage -> auth -> signer -> amber -> storage). It is not any more: the one
// edge that made it real, `coerceProfileMetadata`, moved down into the
// import-free leaf lib/nostr/profile-metadata.ts. Keep it that way — see the
// header of that file.
import { storage } from '../storage';

// The wire format itself lives in ./amber-callback-url, an import-free leaf so
// `npm run check:amber` can load the REAL shipping bytes under plain Node.
// Re-exported here so every existing import site is unchanged.
export type { AmberRequestType } from './amber-callback-url';
export { looksLikeAmberResult } from './amber-callback-url';

// 60s — long enough for the Amber approve flow on a slow phone, short enough
// that a forgotten request doesn't pin the busy state forever.
const AMBER_TIMEOUT_MS = 60_000;

type InvokeOptions = AmberUrlOptions;

// In-flight Amber requests, exposed so a manual-paste UI can resolve them
// without going through the clipboard. Single-flight FIFO: there's no need
// to handle concurrent Amber prompts because the user can only physically
// approve one at a time.
type PendingResolver = (raw: string) => void;
let pendingResolver: { resolve: PendingResolver; reject: (e: Error) => void; type: AmberRequestType } | null = null;

export function getLatestPendingAmber(): { type: AmberRequestType } | null {
  return pendingResolver ? { type: pendingResolver.type } : null;
}

export function submitManualAmberResult(value: string): boolean {
  if (!pendingResolver) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  pendingResolver.resolve(trimmed);
  return true;
}

// Lifecycle stage of the in-flight Amber request, broadcast to UI listeners
// so they don't have to re-implement visibility / focus / gesture detection.
//
//   'idle'     — no request in flight
//   'awaiting' — request dispatched, no return signal yet
//   'returned' — at least one lifecycle / gesture event hinted that the user
//                came back from Amber. Same signal that triggers the
//                clipboard auto-read.
//
// `<AmberCompletion>` subscribes via subscribeAmberStage to flip its hint
// copy from "Approve in Amber…" to "If sign-in didn't complete, tap below."
// Late subscribers receive the current stage on registration so a remount
// mid-request paints correctly.
export type AmberStage = 'idle' | 'awaiting' | 'returned';

let currentStage: AmberStage = 'idle';
const stageListeners = new Set<(s: AmberStage) => void>();

function setStage(next: AmberStage) {
  if (currentStage === next) return;
  currentStage = next;
  for (const fn of stageListeners) {
    try { fn(next); } catch { /* ignore */ }
  }
}

export function subscribeAmberStage(fn: (s: AmberStage) => void): () => void {
  stageListeners.add(fn);
  fn(currentStage);
  return () => { stageListeners.delete(fn); };
}

// Which requests may return through a callbackUrl, i.e. which ones can afford
// to have the page reloaded underneath them.
//
// `get_public_key` ONLY, and this list is not a default to be widened casually.
// Adding a type here means asserting that losing every byte of page state costs
// the user nothing for that request. Two specific things it must never contain:
//
//   `sign_event`, because `publishBoostNote` signs AFTER `sendBoost` has already
//   moved sats (CLAUDE.md boost invariant 1). A reload there destroys the
//   per-leg results — the only screen telling the user which recipients were
//   paid — while the modal is deliberately `dismissable={false}` for exactly
//   that reason. It is also unmatchable on resume: the template carries
//   `created_at: Date.now()/1000`, so a caller that re-asks builds a DIFFERENT
//   request, and resolving it with a parked result would publish an event
//   signed over a template nobody built.
//
//   The decrypts, for now. They ARE deterministic — the ciphertext is the
//   payload, so a re-issued request is byte-identical and a parked result
//   matches exactly — which makes them the obvious next step. They are left out
//   here only because nothing yet re-issues them after a reload; see
//   docs/signers.md.
const RESUMABLE_TYPES: ReadonlySet<AmberRequestType> = new Set(['get_public_key']);

// Both sides of the round trip share one freshness window — see
// AMBER_PENDING_TTL_MS in ./amber-callback-url for why it is defined there.
const fresh = (ts: number) => amberRecordIsFresh(ts, Date.now());

/**
 * A result Amber already handed back, if it answers THIS request.
 *
 * The callback navigation reloads the page, so by the time a caller asks again
 * the answer may already be sitting in sessionStorage. Consuming it here is
 * what makes `invokeAmber` idempotent across that reload — the caller re-issues
 * normally and gets an immediate answer with no second trip to Amber.
 *
 * Strict on purpose, and `take()` is single-use:
 *  - the type must match, so a parked pubkey cannot answer a decrypt;
 *  - the type must be one we actually send through a callback, so a stale
 *    record can never satisfy a request that never used this path;
 *  - the shape must pass `looksLikeAmberResult`;
 *  - it must be fresh.
 * Anything else is dropped rather than returned, because a wrong answer here is
 * indistinguishable from a right one at the call site.
 */
function takeParkedResult(type: AmberRequestType): string | null {
  if (!RESUMABLE_TYPES.has(type)) return null;
  const parked = storage.amberResult.take();
  if (!parked) return null;
  if (parked.type !== type) return null;
  if (!fresh(parked.ts)) return null;
  if (!looksLikeAmberResult(parked.value, type)) return null;
  return parked.value.trim();
}

async function invokeAmber(opts: InvokeOptions): Promise<string> {
  if (typeof window === 'undefined') {
    throw new Error('Amber signer requires a browser environment');
  }
  // Did Amber already answer this, before the callback navigation reloaded us?
  // Checked BEFORE anything else so a resumed request never dispatches a second
  // prompt for a question that has been answered.
  const parked = takeParkedResult(opts.type);
  if (parked) {
    // eslint-disable-next-line no-console
    console.info('[amber] ✓', opts.type, '(resumed from callback)');
    storage.amberPending.clear();
    return parked;
  }

  // Cancel any prior pending request — the user has restarted the flow.
  if (pendingResolver) {
    pendingResolver.reject(new Error('Amber request superseded'));
    pendingResolver = null;
  }
  setStage('awaiting');

  // A callbackUrl is what makes Amber navigate back at all, but it costs a page
  // reload — so only the types that can afford one get it. See RESUMABLE_TYPES.
  const rid = newAmberRequestId();
  const useCallback = RESUMABLE_TYPES.has(opts.type) && typeof location !== 'undefined';
  const callbackUrl = useCallback ? buildAmberCallbackUrl(location.origin, rid) : undefined;
  // An `intent:` URL, never a bare `nostrsigner:` one: Chromium no longer
  // marks the intent as a browser's, and without that mark Amber reads the
  // request from extras a bare URL cannot carry. See amber-callback-url.ts.
  const signerUrl = buildSignerIntentUrl(opts, callbackUrl);

  if (useCallback) {
    // Park what the callback page needs to recognise the answer. No payload and
    // no secret — a request id, the method, and where to send the user back to.
    // Written BEFORE dispatch: Android can foreground Amber faster than a
    // `finally` would run, and a callback arriving before the record exists is
    // a round trip thrown away.
    storage.amberPending.set({
      rid,
      type: opts.type,
      ts: Date.now(),
      origin: `${location.pathname}${location.search}`,
    });
  } else {
    // Clipboard path. Drop an EXPIRED record so a callback arriving long after
    // the fact cannot park a result nothing will consume — but leave a fresh
    // one alone. A background publish (favorites, mutes) can fire while the
    // user is still standing in Amber approving a callback request, and
    // clearing unconditionally would make that unrelated request destroy the
    // record the callback is about to match. The two paths share this key and
    // only one of them can be answered by a navigation.
    const held = storage.amberPending.get();
    if (held && !fresh(held.ts)) storage.amberPending.clear();
  }

  // eslint-disable-next-line no-console
  console.info(
    '[amber] →', opts.type,
    useCallback ? `(callback ${AMBER_CALLBACK_PATH})` : '(clipboard)',
    // Both of these turn a device report of "Amber didn't come back" into a
    // readable line. A hostile payload never reaches a prompt at all; a
    // dispatch with no transient activation is one Chrome may decline to hand
    // to the intent picker, which looks identical from here.
    payloadSurvivesAmber(opts.payload ?? '') ? '' : '(payload contains "?" — Amber will reject it)',
    navigator.userActivation && !navigator.userActivation.isActive ? '(no user activation)' : '',
  );

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (raw: string | null, error?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        // The pending record survives a FAILED callback request on purpose.
        // This promise timing out means the caller stopped waiting; it does not
        // mean Amber will never navigate back. AMBER_TIMEOUT_MS is 60 s and the
        // record is matchable for AMBER_PENDING_TTL_MS, because a cold Amber
        // approve can outrun the shorter clock — and if the callback then lands,
        // the caller re-asks and gets its answer with no second prompt. Clearing
        // here would throw that away and send the user back to Amber for a
        // question they already approved.
        //
        // A clipboard request has no such second chance, so its record goes.
        if (!useCallback) storage.amberPending.clear();
        // eslint-disable-next-line no-console
        console.warn('[amber] ✗', opts.type, error);
        return reject(new Error(error));
      }
      // Answered here, through the clipboard or a manual paste. Drop the record
      // so a callback arriving late for the same request cannot park a result
      // that nothing will ever consume.
      storage.amberPending.clear();
      if (!raw) return reject(new Error('Amber returned no result'));
      // eslint-disable-next-line no-console
      console.info('[amber] ✓', opts.type, 'len=', raw.length);
      resolve(raw);
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageshow);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('pointerdown', onUserGesture, true);
      document.removeEventListener('touchstart', onUserGesture, true);
      document.removeEventListener('keydown', onUserGesture, true);
      if (pendingResolver?.resolve === acceptManual) pendingResolver = null;
      setStage('idle');
    };

    // We try the clipboard from two kinds of triggers:
    //
    //  - Lifecycle events (visibilitychange / pageshow / focus / pagehide)
    //    catch the round-trip when the browser cooperates. They typically
    //    can't read the clipboard themselves on Android Chrome (no transient
    //    user activation), but we still try in case the runtime allows it.
    //
    //  - Capture-phase pointer / touch / key events catch the user's first
    //    gesture after returning from Amber. THIS is the path that actually
    //    works on a standalone PWA — the gesture grants activation and the
    //    `clipboard.readText` inside the handler succeeds. Whatever the user
    //    taps anywhere on the page completes sign-in silently.
    //
    // No `wentHidden` gate: in standalone-PWA mode on Android,
    // `visibilitychange` is unreliable on the way out *too* (we never see
    // the hidden state), so gating on it produced false negatives. The
    // worst case without the gate is one premature read of the user's
    // clipboard at sign-in time — `looksLikeAmberResult` filters anything
    // that isn't a plausible response, so unrelated clipboard content
    // (URLs, plain text) is ignored.
    const tryReadClipboard = async (origin: string) => {
      if (settled) return;
      // Any lifecycle / gesture event that triggered this read counts as
      // "the user might be back" — promote stage so subscribed UI flips
      // its hint copy. Once we've moved past 'awaiting' we stay there
      // until cleanup; subsequent events don't need to re-fire setStage.
      if (currentStage === 'awaiting') setStage('returned');
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[amber] clipboard read denied via', origin, ':', (e as Error)?.message ?? e);
        return;
      }
      if (!text) return;
      if (looksLikeAmberResult(text, opts.type)) {
        // eslint-disable-next-line no-console
        console.info('[amber] auto-resolved via', origin);
        finish(text.trim());
      } else {
        // eslint-disable-next-line no-console
        console.info('[amber] clipboard via', origin, 'didn\'t match expected shape (len=', text.length, ')');
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') return;
      void tryReadClipboard('visibilitychange');
    };
    const onPageshow = () => { void tryReadClipboard('pageshow'); };
    const onFocus = () => { void tryReadClipboard('focus'); };
    const onUserGesture = (e: globalThis.Event) => { void tryReadClipboard(`gesture:${e.type}`); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageshow);
    window.addEventListener('focus', onFocus);
    // Capture phase so we run before any element-specific click/keydown
    // handlers consume the activation. Listeners are removed inside
    // `cleanup()` so they only fire while a single Amber request is in
    // flight.
    document.addEventListener('pointerdown', onUserGesture, true);
    document.addEventListener('touchstart', onUserGesture, true);
    document.addEventListener('keydown', onUserGesture, true);

    // Path 2: manual paste — register a resolver the UI can call
    const acceptManual: PendingResolver = (raw) => finish(raw);
    pendingResolver = {
      resolve: acceptManual,
      reject: (e) => finish(null, e.message),
      type: opts.type,
    };

    // Name the one cause the user cannot otherwise see. Amber rejects a request
    // whose payload contains `?` before it ever shows a prompt, and from this
    // side that is byte-for-byte the same silence as Amber not being installed
    // — which is why docs/signers.md warns not to read this symptom as evidence
    // about the callback code. It stays a MESSAGE and not a pre-dispatch throw:
    // `publishBoostNote` signs after the sats have moved, so refusing to try
    // would turn an Amber limitation into a boost the user paid for and cannot
    // post. A plaintext this app chooses avoids the character instead — see
    // ./amber-safe-text.
    const hostile = !payloadSurvivesAmber(opts.payload ?? '');
    timer = setTimeout(() => {
      finish(
        null,
        hostile
          ? 'Amber rejects requests whose content contains a question mark ("?"), so it never showed a prompt. Remove the "?" and try again.'
          : 'Amber did not respond. Make sure Amber is installed, or paste the result manually.',
      );
    }, AMBER_TIMEOUT_MS);

    // Dispatch via same-tab navigation. The browser turns the `intent:` URL
    // into an ACTION_VIEW at Amber's package; the tab stays alive on the
    // original page because the navigation was hijacked. If Amber isn't
    // installed the browser sends the user to its store listing — the timeout
    // (and the user's reload) recover.
    //
    // We use an anchor click rather than `location.href = …` because some
    // Android browsers handle custom URL schemes from `<a>` clicks more
    // gracefully (intent picker shows up reliably; a bare assignment is
    // sometimes silently blocked as a "navigation hint").
    try {
      const a = document.createElement('a');
      a.href = signerUrl;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      // Last resort: direct location nav.
      try {
        window.location.href = signerUrl;
      } catch (e2) {
        finish(null, `Failed to dispatch Amber: ${(e2 as Error).message}`);
      }
    }
  });
}

/**
 * Amber may answer `get_public_key` as 64-char hex or as an npub. Both are
 * valid; this is the one place that decides what they mean.
 *
 * Exported because the callback path has a SECOND consumer: after Amber
 * navigates back, the page reloads and `<NostrAuth>` picks the parked result up
 * on mount rather than through `AmberSigner`. Two copies of this would be two
 * places to disagree about what a returned key is — and the disagreement would
 * be silent, because both branches produce a plausible 64-char string.
 *
 * Throws on anything else rather than guessing. A wrong pubkey here is an
 * account the user does not own.
 */
export function normalizeAmberPubkey(raw: string): string {
  const trimmed = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (trimmed.startsWith('npub1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== 'npub') {
      throw new Error(`Amber returned unexpected pubkey shape: ${trimmed.slice(0, 24)}…`);
    }
    return decoded.data;
  }
  throw new Error(`Amber returned unexpected pubkey shape: ${trimmed.slice(0, 24)}…`);
}

export interface AmberSignerInterface {
  getPublicKey(): Promise<string>;
  signEvent(template: EventTemplate): Promise<Event>;
  nip04: {
    encrypt(peerPubkey: string, plaintext: string): Promise<string>;
    decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
  };
  nip44: {
    encrypt(peerPubkey: string, plaintext: string): Promise<string>;
    decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
  };
}

export class AmberSigner implements AmberSignerInterface {
  private cachedPubkey: string | null;

  constructor(savedPubkey?: string) {
    this.cachedPubkey = savedPubkey ?? null;
  }

  async getPublicKey(): Promise<string> {
    if (this.cachedPubkey) return this.cachedPubkey;
    this.cachedPubkey = normalizeAmberPubkey(await invokeAmber({ type: 'get_public_key' }));
    return this.cachedPubkey;
  }

  async signEvent(template: EventTemplate): Promise<Event> {
    // Amber URL-decodes the whole `nostrsigner:` URI and splits it on `?`
    // BEFORE it parses the JSON, so a literal `?` anywhere in the template —
    // a typed message, a permalink item guid, and the two URLs `formatContent`
    // writes into EVERY boost note — truncated the request and Amber answered
    // "Invalid request". `\u003f` is the same string to Amber's JSON parser
    // and is not a `?` to its splitter; the event it signs is byte-identical
    // to the one it would have signed. See ./amber-safe-text.
    const eventJson = escapeJsonForAmber(JSON.stringify(template));
    const signed = await invokeAmber({
      type: 'sign_event',
      payload: eventJson,
      returnType: 'event',
    });
    let event: Event;
    try {
      event = JSON.parse(signed) as Event;
    } catch {
      throw new Error('Amber returned a malformed signed event');
    }
    // The result travels via the system clipboard (auto-read or manual
    // paste), so verify it really is a validly-signed copy of our request
    // before letting it anywhere near a relay.
    if (!verifyEvent(event)) {
      throw new Error('Amber returned an event with an invalid signature');
    }
    if (this.cachedPubkey && event.pubkey !== this.cachedPubkey) {
      throw new Error('Amber returned an event signed by a different key than the signed-in account');
    }
    return event;
  }

  nip04 = {
    encrypt: (peerPubkey: string, plaintext: string) =>
      invokeAmber({ type: 'nip04_encrypt', payload: plaintext, pubkey: peerPubkey }),
    decrypt: (peerPubkey: string, ciphertext: string) =>
      invokeAmber({ type: 'nip04_decrypt', payload: ciphertext, pubkey: peerPubkey }),
  };

  nip44 = {
    encrypt: (peerPubkey: string, plaintext: string) =>
      invokeAmber({ type: 'nip44_encrypt', payload: plaintext, pubkey: peerPubkey }),
    decrypt: (peerPubkey: string, ciphertext: string) =>
      invokeAmber({ type: 'nip44_decrypt', payload: ciphertext, pubkey: peerPubkey }),
  };
}

/** Loose Android UA sniff. Used to gate the Amber sign-in fallback so desktop
 *  / iOS users don't get a dispatched URL their OS can't handle. */
export function isLikelyAndroid(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /android/i.test(navigator.userAgent);
}

/** Loose iOS UA sniff. Catches iPhone / iPad / iPod, plus the iPadOS-as-Mac
 *  case (recent iPads identify as Macintosh in the UA but expose touch). */
export function isLikelyIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  if (/Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1) return true;
  return false;
}
