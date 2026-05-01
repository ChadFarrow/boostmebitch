'use client';

// NIP-55 Amber signer (Android).
//
// Amber is an Android-only Nostr signer app. There's no persistent web
// connection — every request opens a tab navigating to a `nostrsigner:` deep
// link, which launches Amber. After the user approves, Amber redirects to a
// callback URL on our origin (handled by app/amber-callback/page.tsx). The
// callback page extracts the result and posts it back via a BroadcastChannel
// keyed by a per-request id, the popup closes itself, and the awaiting promise
// resolves in the original tab.
//
// Trade-off worth knowing: each signEvent / nip04.* / nip44.* call shows the
// Amber prompt. Background-published events that the rest of the app debounces
// (favorites, mutes) will visibly prompt the user. That's inherent to the
// NIP-55 web flow — there's no way to pre-authorize like NWC does.

import { nip19, type Event, type EventTemplate } from 'nostr-tools';

export const AMBER_BROADCAST_CHANNEL = 'bmb:amber-result';
export const AMBER_CALLBACK_PATH = '/amber-callback';

// 2 minutes — enough time to read the Amber prompt and tap approve. Any
// longer and a forgotten request keeps the listener pinned forever; any
// shorter and slow phones / Always-Allow re-prompts time out.
const AMBER_TIMEOUT_MS = 120_000;

export type AmberRequestType =
  | 'get_public_key'
  | 'sign_event'
  | 'nip04_encrypt'
  | 'nip04_decrypt'
  | 'nip44_encrypt'
  | 'nip44_decrypt';

export interface AmberResultMessage {
  id: string;
  /** Hex pubkey, signed-event JSON, ciphertext, or plaintext (depending on type). */
  result?: string;
  /** Bare signature when Amber returns returnType=signature for sign_event. */
  signature?: string;
  /** Human-readable error message when Amber rejects or the user cancels. */
  error?: string;
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
  params.set('callbackUrl', callbackUrl);
  if (opts.pubkey) params.set('pubkey', opts.pubkey);
  // Payload (event JSON / plaintext / ciphertext) goes immediately after the
  // scheme, URI-encoded. Empty payload for get_public_key.
  return `nostrsigner:${encodeURIComponent(opts.payload ?? '')}?${params.toString()}`;
}

async function invokeAmber(opts: InvokeOptions): Promise<string> {
  if (typeof window === 'undefined') {
    throw new Error('Amber signer requires a browser environment');
  }
  if (typeof BroadcastChannel === 'undefined') {
    throw new Error('Your browser does not support BroadcastChannel — required for Amber.');
  }

  const id = randomId();
  const callbackUrl = new URL(AMBER_CALLBACK_PATH, window.location.origin);
  callbackUrl.searchParams.set('id', id);

  const signerUrl = buildSignerUrl(opts, callbackUrl.toString());

  return new Promise<string>((resolve, reject) => {
    const channel = new BroadcastChannel(AMBER_BROADCAST_CHANNEL);
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      channel.close();
      if (timer) clearTimeout(timer);
    };

    channel.onmessage = (e) => {
      const msg = e.data as AmberResultMessage | undefined;
      if (!msg || msg.id !== id) return;
      cleanup();
      if (msg.error) return reject(new Error(msg.error));
      const value = msg.result ?? msg.signature;
      if (!value) return reject(new Error('Amber returned no result'));
      resolve(value);
    };

    timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          'Amber did not respond. Make sure the Amber app is installed and try again.',
        ),
      );
    }, AMBER_TIMEOUT_MS);

    // window.open with target=_blank: Android Chrome resolves nostrsigner: via
    // the OS intent picker → Amber. After signing, Amber returns to callbackUrl
    // in the same popup tab, which then posts via BroadcastChannel and closes.
    const popup = window.open(signerUrl, '_blank');
    if (!popup) {
      cleanup();
      reject(new Error('Browser blocked the Amber popup. Allow popups for this site and retry.'));
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
    if (/^[0-9a-f]{64}$/i.test(raw)) {
      this.cachedPubkey = raw.toLowerCase();
    } else if (raw.startsWith('npub1')) {
      const decoded = nip19.decode(raw);
      if (decoded.type !== 'npub') {
        throw new Error(`Amber returned unexpected pubkey shape: ${raw.slice(0, 24)}…`);
      }
      this.cachedPubkey = decoded.data;
    } else {
      throw new Error(`Amber returned unexpected pubkey shape: ${raw.slice(0, 24)}…`);
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
