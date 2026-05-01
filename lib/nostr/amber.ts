'use client';

// NIP-55 Amber signer (Android).
//
// Production Nostr web apps that target Amber use this flow:
//
//   1. Same-tab navigation to `nostrsigner:<payload>?type=…&returnType=…`
//      with NO callbackUrl. Per NIP-55: "If you don't send a callback url,
//      Signer Application will copy the result to the clipboard."
//   2. Android's intent system hijacks the navigation; the browser tab stays
//      on the original page while Amber comes to foreground.
//   3. User approves; Amber writes the result (pubkey / signed event /
//      ciphertext / plaintext) to the system clipboard and returns focus.
//   4. The browser tab fires `visibilitychange` (visible again); we read the
//      clipboard and resolve the pending request.
//
// This is what the user means when they describe other apps "switching to
// Amber and back" seamlessly. There's no popup tab, no callback URL, no
// cross-tab message passing — just a URL-scheme dispatch and a clipboard read.
//
// Trade-off worth knowing: each signEvent / nip04.* / nip44.* call shows the
// Amber prompt. Background-published events that the rest of the app debounces
// (favorites, mutes) will visibly switch to Amber. That's inherent to NIP-55.
//
// Manual paste is kept as a last-resort UI: if the clipboard read is denied
// (private mode, browser policy, no user gesture) the user can still paste
// the result by hand.

import { nip19, type Event, type EventTemplate } from 'nostr-tools';

export type AmberRequestType =
  | 'get_public_key'
  | 'sign_event'
  | 'nip04_encrypt'
  | 'nip04_decrypt'
  | 'nip44_encrypt'
  | 'nip44_decrypt';

// 60s — long enough for the Amber approve flow on a slow phone, short enough
// that a forgotten request doesn't pin the busy state forever.
const AMBER_TIMEOUT_MS = 60_000;

interface InvokeOptions {
  type: AmberRequestType;
  /** event JSON, plaintext, or ciphertext — encoded after `nostrsigner:`. */
  payload?: string;
  /** Peer pubkey for nip04/nip44 operations. */
  pubkey?: string;
  /** Amber's returnType param. `event` returns the signed event JSON for
   *  sign_event; `signature` returns just the bare signature. We always use
   *  `event` for sign_event so the caller gets a complete `Event`. */
  returnType?: 'signature' | 'event';
}

function buildSignerUrl(opts: InvokeOptions): string {
  // Match the NIP-55 spec example byte-for-byte. Params written raw, payload
  // URI-encoded after the colon. NO callbackUrl → Amber uses clipboard for
  // the return value.
  let url = `nostrsigner:${encodeURIComponent(opts.payload ?? '')}`;
  url += `?compressionType=none`;
  url += `&returnType=${opts.returnType ?? 'signature'}`;
  url += `&type=${opts.type}`;
  if (opts.pubkey) url += `&pubkey=${opts.pubkey}`;
  return url;
}

// Best-effort sanity check on a clipboard read so we don't accidentally
// resolve with an unrelated string the user happened to copy. Different
// types have different shapes:
//   - get_public_key: 64-hex-char or starts with `npub1`
//   - sign_event: JSON object with a `sig` field
//   - nip04/nip44: opaque ciphertext/plaintext — can't validate, accept anything
function looksLikeAmberResult(text: string, type: AmberRequestType): boolean {
  const t = text.trim();
  if (!t) return false;
  if (type === 'get_public_key') {
    return /^[0-9a-f]{64}$/i.test(t) || t.startsWith('npub1');
  }
  if (type === 'sign_event') {
    if (!t.startsWith('{')) return false;
    try {
      const parsed = JSON.parse(t);
      return typeof parsed === 'object' && parsed && typeof parsed.sig === 'string';
    } catch {
      return false;
    }
  }
  // nip04/nip44 — no reliable shape check. Trust the caller.
  return true;
}

// In-flight Amber requests, exposed so a manual-paste UI can resolve them
// without going through the clipboard. Single-flight FIFO: there's no need
// to handle concurrent Amber prompts because the user can only physically
// approve one at a time.
type PendingResolver = (raw: string) => void;
let pendingResolver: { resolve: PendingResolver; reject: (e: Error) => void; type: AmberRequestType } | null = null;

export function getLatestPendingAmber(): { type: AmberRequestType } | null {
  return pendingResolver ? { type: pendingResolver.type } : null;
}

export function submitManualAmberResult(_id: string, value: string): boolean {
  // _id ignored — single-flight model.
  if (!pendingResolver) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  pendingResolver.resolve(trimmed);
  return true;
}

async function invokeAmber(opts: InvokeOptions): Promise<string> {
  if (typeof window === 'undefined') {
    throw new Error('Amber signer requires a browser environment');
  }
  // Cancel any prior pending request — the user has restarted the flow.
  if (pendingResolver) {
    pendingResolver.reject(new Error('Amber request superseded'));
    pendingResolver = null;
  }

  const signerUrl = buildSignerUrl(opts);
  // eslint-disable-next-line no-console
  console.info('[amber] →', opts.type);

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (raw: string | null, error?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        // eslint-disable-next-line no-console
        console.warn('[amber] ✗', opts.type, error);
        return reject(new Error(error));
      }
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

    timer = setTimeout(() => {
      finish(
        null,
        'Amber did not respond. Make sure Amber is installed, or paste the result manually.',
      );
    }, AMBER_TIMEOUT_MS);

    // Dispatch nostrsigner: via same-tab navigation. Android intercepts the
    // URL scheme and routes to Amber; the browser tab stays alive on the
    // original page because the navigation was hijacked. If Amber isn't
    // installed the browser will navigate to an error page — the timeout
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
    const raw = await invokeAmber({ type: 'get_public_key' });
    const trimmed = raw.trim();
    if (/^[0-9a-f]{64}$/i.test(trimmed)) {
      this.cachedPubkey = trimmed.toLowerCase();
    } else if (trimmed.startsWith('npub1')) {
      const decoded = nip19.decode(trimmed);
      if (decoded.type !== 'npub') {
        throw new Error(`Amber returned unexpected pubkey shape: ${trimmed.slice(0, 24)}…`);
      }
      this.cachedPubkey = decoded.data;
    } else {
      throw new Error(`Amber returned unexpected pubkey shape: ${trimmed.slice(0, 24)}…`);
    }
    return this.cachedPubkey;
  }

  async signEvent(template: EventTemplate): Promise<Event> {
    const eventJson = JSON.stringify(template);
    const signed = await invokeAmber({
      type: 'sign_event',
      payload: eventJson,
      returnType: 'event',
    });
    try {
      return JSON.parse(signed) as Event;
    } catch {
      throw new Error('Amber returned a malformed signed event');
    }
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
