// NIP-07 sign-in. The window globals declared here cover both the Nostr
// signer and the WebLN provider (Lightning lib in @/lib/v4v/webln also uses
// it via this same module-level declaration).
//
// Amber (NIP-55, Android) is supported by polyfilling window.nostr with an
// AmberSigner instance — see lib/nostr/signer.ts and lib/nostr/amber.ts. The
// rest of the app reads window.nostr without caring which backend it is.

import { nip19, type Event, type EventTemplate } from 'nostr-tools';
import {
  activateAmberSigner,
  activateBunkerSigner,
  deactivateAmberSigner,
  deactivateBunkerSigner,
} from './signer';
import {
  bunkerUriForRestore,
  clearBunkerStale,
  connectBunkerFromUri,
  restoreBunkerFromStorage,
  startNostrConnect,
  type BunkerAdapter,
} from './bunker';
import { storage } from '../storage';

declare global {
  interface Window {
    nostr?: {
      getPublicKey: () => Promise<string>;
      signEvent: (e: EventTemplate) => Promise<Event>;
      nip04?: {
        encrypt: (pubkey: string, plaintext: string) => Promise<string>;
        decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
      };
      // NIP-44 v2. Used to encrypt-to-self the Spark wallet mnemonic for the
      // Nostr-hosted backup in lib/nostr/wallet-backup.ts.
      nip44?: {
        encrypt: (pubkey: string, plaintext: string) => Promise<string>;
        decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
      };
    };
    webln?: {
      enable: () => Promise<void>;
      sendPayment: (invoice: string) => Promise<{ preimage: string }>;
      keysend?: (args: {
        destination: string;
        amount: number;
        customRecords?: Record<string, string>;
      }) => Promise<{ preimage: string }>;
      lnurl?: (lnurl: string) => Promise<any>;
    };
  }
}

export interface ProfileMetadata {
  name?: string;
  display_name?: string;
  picture?: string;
  nip05?: string;
  about?: string;
  lud16?: string;        // Lightning address (user@domain) — used by NIP-57 zaps
  lud06?: string;        // bech32-encoded LNURL — older spec, fallback when lud16 is absent
}

export interface NostrIdentity {
  pubkey: string;        // hex
  npub: string;          // bech32
  profile?: ProfileMetadata;
  writeRelays?: string[]; // from NIP-65 kind:10002 (write or unmarked entries)
}

export async function loginWithExtension(): Promise<NostrIdentity> {
  if (typeof window === 'undefined' || !window.nostr) {
    throw new Error(
      'No Nostr signer found. Install Alby, nos2x, or another NIP-07 extension.',
    );
  }
  const pubkey = await window.nostr.getPublicKey();
  return { pubkey, npub: nip19.npubEncode(pubkey) };
}

/**
 * Sign in via the Amber Android signer (NIP-55). Installs an AmberSigner as
 * window.nostr so subsequent signEvent / nip04 / nip44 calls route through
 * the same `nostrsigner:` deep-link flow; the original window.nostr (a
 * NIP-07 extension, if any) is restored on sign-out.
 *
 * The first call opens an Amber popup tab to fetch the pubkey. Subsequent
 * page loads can call `restoreAmberSigner` instead — synchronous, no popup.
 */
export async function loginWithAmber(): Promise<NostrIdentity> {
  const signer = activateAmberSigner();
  try {
    const pubkey = await signer.getPublicKey();
    return { pubkey, npub: nip19.npubEncode(pubkey) };
  } catch (e) {
    // Roll back the polyfill if Amber rejected/timed out — otherwise we'd
    // leave window.nostr pointing at an Amber instance the user never agreed
    // to, and the next signEvent would silently re-prompt them through Amber.
    deactivateAmberSigner();
    throw e;
  }
}

/**
 * Reinstall the AmberSigner polyfill on page load when the user previously
 * signed in with Amber. Synchronous — does NOT call Amber. The cached pubkey
 * lets the signer answer getPublicKey() without a popup, mirroring how
 * NIP-07 extensions hold the pubkey in memory.
 */
export function restoreAmberSigner(pubkey: string) {
  activateAmberSigner(pubkey);
}

/** Drop the Amber polyfill, restoring the underlying window.nostr (if any). */
export function clearAmberSigner() {
  deactivateAmberSigner();
}

/**
 * Sign in via a NIP-46 bunker URI (paste flow). The user has copied a
 * `bunker://…` URI (or a NIP-05 like `name@example.com`) from their
 * remote signer; we generate a fresh client secret, connect, and install
 * the adapter as window.nostr.
 *
 * `onAuthUrl` fires when the bunker requires the user to open a URL to
 * approve the connection (e.g. nsec.app's first-time flow). Surface that
 * URL in the UI so the user can complete it.
 */
export async function loginWithBunker(
  input: string,
  onAuthUrl?: (url: string) => void,
): Promise<NostrIdentity> {
  const adapter = await connectBunkerFromUri(input, onAuthUrl);
  return finalizeBunkerLogin(adapter);
}

/**
 * Sign in via a NIP-46 nostrconnect:// URI (generate flow). Returns the
 * URI immediately for the caller to display, plus a `ready` promise that
 * resolves to a `NostrIdentity` once the signer connects back. Caller is
 * responsible for showing the URI to the user (paste / QR / copy) until
 * the promise settles.
 */
export function loginWithNostrConnect(
  onAuthUrl?: (url: string) => void,
): { uri: string; ready: Promise<NostrIdentity> } {
  const { uri, ready: adapterReady } = startNostrConnect(onAuthUrl);
  const ready = adapterReady.then((adapter) => finalizeBunkerLogin(adapter));
  return { uri, ready };
}

function finalizeBunkerLogin(adapter: BunkerAdapter): NostrIdentity {
  // The adapter's `uri` is whatever we connected with (bunker:// or
  // nostrconnect://). For restore-on-reload we need a bunker:// pointer,
  // so build one from the underlying signer's BunkerPointer if needed.
  const persistUri = bunkerUriForRestore(adapter);
  storage.bunker.set({ uri: persistUri, clientSk: adapter.clientSkHex });
  activateBunkerSigner(adapter);
  return {
    pubkey: adapter.pubkey,
    npub: nip19.npubEncode(adapter.pubkey),
  };
}

/**
 * Restore the bunker signer on page load when `storage.signer` is
 * `'bunker'`. Async — has to reconnect the NIP-46 transport. The fast-
 * path useEffect kicks this off in the background; signing operations
 * that arrive before it resolves will throw, but nothing signs unprompted
 * right after page load so this is fine in practice.
 *
 * Returns true on success, false if no session was persisted or the
 * reconnect failed (in which case the caller should drop the bunker
 * signer-kind sentinel so the UI shows the sign-in button again).
 */
export async function restoreBunkerSigner(): Promise<boolean> {
  try {
    const adapter = await restoreBunkerFromStorage();
    if (!adapter) return false;
    activateBunkerSigner(adapter);
    clearBunkerStale();
    return true;
  } catch {
    return false;
  }
}

/** Drop the bunker polyfill + persisted session, restoring the underlying
 *  window.nostr (if any). */
export function clearBunkerSigner() {
  deactivateBunkerSigner();
  storage.bunker.clear();
}

export function shortNpub(npub: string, len = 8) {
  if (npub.length <= len * 2 + 1) return npub;
  return `${npub.slice(0, len)}…${npub.slice(-len)}`;
}

// Drop fields that aren't strings (some kind:0 events in the wild ship `name`
// as a number, `picture` as null, etc., and the `as ProfileMetadata` cast at
// JSON.parse-time hides that — until a `.trim()` or `.toLowerCase()` blows up
// during render and takes the whole feed surface down with it).
const PROFILE_STRING_FIELDS = [
  'name',
  'display_name',
  'picture',
  'nip05',
  'about',
  'lud16',
  'lud06',
] as const;

export function coerceProfileMetadata(value: unknown): ProfileMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const out: ProfileMetadata = {};
  for (const key of PROFILE_STRING_FIELDS) {
    const raw = v[key];
    if (typeof raw === 'string') out[key] = raw;
  }
  return out;
}

/** Parse a kind:0 event's `content` and return a sanitized ProfileMetadata.
 *  Returns null if the content isn't valid JSON or isn't an object. */
export function parseProfileContent(content: string): ProfileMetadata | null {
  try {
    return coerceProfileMetadata(JSON.parse(content));
  } catch {
    return null;
  }
}
