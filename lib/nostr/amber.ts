'use client';

// NIP-55 Amber signer (Android).
//
// Amber is an Android-only Nostr signer app. There's no persistent web
// connection — every request opens a tab navigating to a `nostrsigner:` deep
// link, which launches Amber. After the user approves, Amber redirects to a
// callback URL on our origin (handled by app/amber-callback/page.tsx).
//
// Result delivery is genuinely fragile across the Amber-version + Android-OS +
// browser-routing matrix, so we listen on FOUR channels in parallel:
//
//   1. BroadcastChannel — same-origin pubsub, reaches across tabs in the same
//      browser (the most common path when Amber's callback opens in a new tab
//      of the same browser).
//   2. window.opener.postMessage — when Amber returns to the popup we opened
//      and the popup is still on our origin, the callback page can post back
//      to its opener directly. Works even if BroadcastChannel is disabled.
//   3. localStorage 'storage' event — fires across tabs of the same origin.
//      Some browsers proxy this when BroadcastChannel is partitioned (private
//      browsing, some Brave/Tor setups).
//   4. Manual paste — last-resort UI affordance the caller can hook into via
//      the exported `submitManualResult(id, result)` helper. Used when the
//      callback URL opens in a different browser than boostmebitch (e.g. Amber
//      defaulted to Brave but the app is in Chrome) so cross-process channels
//      don't reach back.
//
// Trade-off worth knowing: each signEvent / nip04.* / nip44.* call shows the
// Amber prompt. Background-published events that the rest of the app debounces
// (favorites, mutes) will visibly prompt the user. That's inherent to NIP-55.

import { nip19, type Event, type EventTemplate } from 'nostr-tools';

export const AMBER_BROADCAST_CHANNEL = 'bmb:amber-result';
export const AMBER_CALLBACK_PATH = '/amber-callback';
export const AMBER_STORAGE_KEY_PREFIX = 'bmb:amber-result:';

// 60s — 2 min was overlong; if the round-trip hasn't completed by 60s, the
// user has either backgrounded the flow or the callback never reached us.
// The manual-paste fallback handles the latter without forcing a long wait.
const AMBER_TIMEOUT_MS = 60_000;

export type AmberRequestType =
  | 'get_public_key'
  | 'sign_event'
  | 'nip04_encrypt'
  | 'nip04_decrypt'
  | 'nip44_encrypt'
  | 'nip44_decrypt';

export interface AmberResultMessage {
  /** 32-hex-char request id; matches the `id` query param on the callback URL. */
  id: string;
  /** Hex pubkey, signed-event JSON, ciphertext, or plaintext (depending on type). */
  result?: string;
  /** Bare signature when Amber returns returnType=signature for sign_event. */
  signature?: string;
  /** Human-readable error message when Amber rejects or the user cancels. */
  error?: string;
  /** postMessage discriminator so we ignore unrelated cross-window messages. */
  source?: 'bmb:amber';
}

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

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function buildSignerUrl(opts: InvokeOptions, callbackUrl: string): string {
  const params = new URLSearchParams();
  params.set('type', opts.type);
  params.set('compressionType', 'none');
  params.set('returnType', opts.returnType ?? 'signature');
  // Amber appends the raw result to the callbackUrl verbatim — there's no
  // automatic param name. Per the NIP-55 example
  // (https://github.com/nostr-protocol/nips/blob/master/55.md), the
  // convention is to terminate the callback URL with `&event=` so the
  // final URL is `…?id=<id>&event=<result>`. Without this suffix, the
  // result mashes onto the end of the URL with no separator and the
  // callback page can't parse it.
  params.set('callbackUrl', `${callbackUrl}&event=`);
  if (opts.pubkey) params.set('pubkey', opts.pubkey);
  // Payload (event JSON / plaintext / ciphertext) goes immediately after the
  // scheme, URI-encoded. Empty payload for get_public_key.
  return `nostrsigner:${encodeURIComponent(opts.payload ?? '')}?${params.toString()}`;
}

// Track in-flight requests so the manual-paste UI (and any other recovery
// path) can complete them. Keyed by id.
type PendingResolver = (msg: AmberResultMessage) => void;
const pending = new Map<string, { resolve: PendingResolver; type: AmberRequestType }>();

/** Tracker for the most-recent in-flight Amber request so a manual-paste UI
 *  can target it without having to thread the id through every component. */
let latestPending: { id: string; type: AmberRequestType } | null = null;

export function getLatestPendingAmber() {
  return latestPending;
}

/** Resolve a pending Amber request from outside the original promise chain
 *  (e.g. from a manual-paste form). Returns true if a matching request was
 *  found and resolved. */
export function submitManualAmberResult(
  id: string,
  result: string,
): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  entry.resolve({ id, result });
  return true;
}

async function invokeAmber(opts: InvokeOptions): Promise<string> {
  if (typeof window === 'undefined') {
    throw new Error('Amber signer requires a browser environment');
  }

  const id = randomId();
  const callbackUrl = new URL(AMBER_CALLBACK_PATH, window.location.origin);
  callbackUrl.searchParams.set('id', id);
  const signerUrl = buildSignerUrl(opts, callbackUrl.toString());

  // eslint-disable-next-line no-console
  console.info('[amber] →', opts.type, 'id=', id.slice(0, 8));

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let channel: BroadcastChannel | null = null;

    const accept = (msg: AmberResultMessage) => {
      if (settled) return;
      if (msg.id !== id) return;
      settled = true;
      cleanup();
      if (msg.error) {
        // eslint-disable-next-line no-console
        console.warn('[amber] ✗', opts.type, msg.error);
        return reject(new Error(msg.error));
      }
      const value = msg.result ?? msg.signature;
      if (!value) return reject(new Error('Amber returned no result'));
      // eslint-disable-next-line no-console
      console.info('[amber] ✓', opts.type, 'len=', value.length);
      resolve(value);
    };

    const onMessage = (e: MessageEvent) => {
      if (e.origin && e.origin !== window.location.origin) return;
      const msg = e.data as AmberResultMessage | undefined;
      if (!msg || msg.source !== 'bmb:amber') return;
      accept(msg);
    };

    const onStorage = (e: StorageEvent) => {
      if (!e.key || !e.key.startsWith(AMBER_STORAGE_KEY_PREFIX)) return;
      if (!e.newValue) return;
      try {
        const msg = JSON.parse(e.newValue) as AmberResultMessage;
        accept(msg);
      } catch {
        /* ignore malformed entries */
      }
    };

    const cleanup = () => {
      pending.delete(id);
      if (latestPending?.id === id) latestPending = null;
      if (timer) clearTimeout(timer);
      try { channel?.close(); } catch { /* ignore */ }
      window.removeEventListener('message', onMessage);
      window.removeEventListener('storage', onStorage);
    };

    // Path 1: BroadcastChannel
    try {
      channel = new BroadcastChannel(AMBER_BROADCAST_CHANNEL);
      channel.onmessage = (e) => accept(e.data as AmberResultMessage);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[amber] BroadcastChannel unavailable:', e);
    }

    // Path 2: postMessage from the popup we opened
    window.addEventListener('message', onMessage);

    // Path 3: localStorage 'storage' events from a callback tab in the same browser
    window.addEventListener('storage', onStorage);

    // Path 4: manual paste — register so external callers can resolve us
    pending.set(id, { resolve: accept, type: opts.type });
    latestPending = { id, type: opts.type };

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(
          'Amber did not return automatically. If you saw the request and approved it, ' +
            'paste the pubkey/signature from Amber manually, or try again.',
        ),
      );
    }, AMBER_TIMEOUT_MS);

    // Open the nostrsigner: deep link. We open a blank popup first then set
    // its href because some Android browsers don't dispatch the OS intent if
    // window.open is given a non-http URL directly — they show a blocked-popup
    // notice instead. Two-step is more reliable across Chrome/Brave/Samsung.
    let popup: Window | null = null;
    try {
      popup = window.open('', '_blank');
    } catch {
      /* will retry below */
    }
    if (popup) {
      try {
        popup.location.href = signerUrl;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[amber] popup.location.href failed, falling back to window.open(url):', e);
        try { popup.close(); } catch { /* ignore */ }
        popup = null;
      }
    }
    if (!popup) {
      // Fallback: try the direct form. Some browsers prefer this for custom schemes.
      popup = window.open(signerUrl, '_blank');
    }
    if (!popup) {
      settled = true;
      cleanup();
      reject(
        new Error(
          'Browser blocked the Amber popup. Allow popups for this site and retry.',
        ),
      );
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
    // Older Amber versions return the npub bech32 string; newer versions
    // return raw hex. Normalize to hex so the rest of the app sees the same
    // shape as a NIP-07 extension.
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

/** Loose Android UA sniff. False negatives are fine — the Amber button is
 *  shown anyway when no NIP-07 extension is detected, so iOS / desktop users
 *  see it as a fallback option. */
export function isLikelyAndroid(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /android/i.test(navigator.userAgent);
}
