// NIP-07 sign-in. The window globals declared here cover both the Nostr
// signer and the WebLN provider (Lightning lib in @/lib/v4v/webln also uses
// it via this same module-level declaration).
//
// Amber (NIP-55, Android) is supported by polyfilling window.nostr with an
// AmberSigner instance — see lib/nostr/signer.ts and lib/nostr/amber.ts. The
// rest of the app reads window.nostr without caring which backend it is.

import { nip19, type Event, type EventTemplate } from 'nostr-tools';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  activateAmberSigner,
  activateBunkerSigner,
  activateLocalSigner,
  deactivateAmberSigner,
  deactivateBunkerSigner,
  deactivateLocalSigner,
} from './signer';
import { clearKey, getKey, putKey } from './local-key-store';
import {
  bunkerUriForRestore,
  clearBunkerStale,
  connectBunkerFromUri,
  restoreBunkerFromStorage,
  startNostrConnect,
  type BunkerAdapter,
} from './bunker';
import { storage } from '../storage';
import type { ProfileMetadata } from './profile-metadata';

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
 *
 * `abandon` is passed straight through from `startNostrConnect` rather than
 * wrapped: a caller that opens a second listener on this pairing has to be able
 * to close the first, and this is the only layer between it and the UI.
 */
export function loginWithNostrConnect(
  onAuthUrl?: (url: string) => void,
): { uri: string; ready: Promise<NostrIdentity>; abandon: () => void } {
  const { uri, ready: adapterReady, abandon } = startNostrConnect(onAuthUrl);
  const ready = adapterReady.then((adapter) => finalizeBunkerLogin(adapter));
  // Same reason as `startNostrConnect`'s own: `.then` makes a NEW promise, and
  // an abandoned attempt rejecting it with nobody attached is an unhandled
  // rejection for a routine event.
  ready.catch(() => { /* the caller's own handler reports what matters */ });
  return { uri, ready, abandon };
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

/**
 * Sign in with a key this app holds itself (the Google-onboarding path — see
 * components/nostr-auth/google-auth-panel.tsx). Installs the LocalSigner
 * polyfill and persists the key behind a non-extractable CryptoKey.
 *
 * The multi-step Google UX (PIN entry, account picker) deliberately stays in
 * the component; this is the thin part, mirroring finalizeBunkerLogin.
 */
export async function loginWithLocalKey(skHex: string): Promise<NostrIdentity> {
  const signer = activateLocalSigner(skHex);
  try {
    await putKey(skHex);
    const pubkey = await signer.getPublicKey();
    return { pubkey, npub: nip19.npubEncode(pubkey) };
  } catch (e) {
    // Roll the polyfill back rather than leaving window.nostr pointing at a
    // signer whose key we failed to persist.
    deactivateLocalSigner();
    throw e;
  }
}

/**
 * Reinstall the LocalSigner on page load. Async, unlike restoreAmberSigner —
 * the key has to come back out of IndexedDB and be decrypted. Modeled on the
 * bunker restore: signing calls that race ahead of it throw, but nothing signs
 * unprompted right after load.
 *
 * Returns false when no key is stored (or storage is unreadable), so the
 * caller can drop the signer-kind sentinel and show sign-in again.
 */
export async function restoreLocalSigner(): Promise<boolean> {
  try {
    const skHex = await getKey();
    if (!skHex) return false;
    // The stored key must match the identity the rest of the app is about to
    // paint from `bmb:npub`. These CAN disagree: putKey swallows IndexedDB
    // failures, so signing in as B on a device that already held A's key can
    // leave A's ciphertext on disk while the session runs off the in-memory
    // copy. After a reload the app would then sign every event as A while the
    // header, favorites, mutes and wallet all say B — and the resulting
    // nip44 failures are swallowed by their callers, so nothing surfaces it.
    // Refusing here sends the user back through sign-in instead.
    const stored = storage.npub.get();
    if (stored) {
      const pubkey = getPublicKey(hexToBytes(skHex));
      if (nip19.npubEncode(pubkey) !== stored) return false;
    }
    activateLocalSigner(skHex);
    return true;
  } catch {
    return false;
  }
}

/** Drop the local polyfill and wipe the stored key. */
export async function clearLocalSigner() {
  deactivateLocalSigner();
  await clearKey();
}



// `ProfileMetadata`, `coerceProfileMetadata` and `parseProfileContent` moved to
// ./profile-metadata, an import-free leaf, so `lib/storage.ts` can reach them
// without importing this file — that one edge was what made
// storage → auth → signer → amber → storage a real cycle. Re-exported here so
// every existing import site (and the `lib/nostr` barrel) is unchanged.
//
// `shortNpub` moved down for the same reason and by the same rule: it is a pure
// string elision that `lib/format.tsx` needs to render a mention, and 18
// modules import `lib/format.tsx` — reaching it through here would pull the
// signer stack into all of them.
export {
  coerceProfileMetadata,
  parseProfileContent,
  shortNpub,
  type ProfileMetadata,
} from './profile-metadata';
