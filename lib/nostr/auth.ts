// NIP-07 sign-in. The window globals declared here cover both the Nostr
// signer and the WebLN provider (Lightning lib in @/lib/v4v/webln also uses
// it via this same module-level declaration).
//
// Amber (NIP-55, Android) is supported by polyfilling window.nostr with an
// AmberSigner instance — see lib/nostr/signer.ts and lib/nostr/amber.ts. The
// rest of the app reads window.nostr without caring which backend it is.

import { nip19, type Event, type EventTemplate } from 'nostr-tools';
import { activateAmberSigner, deactivateAmberSigner } from './signer';

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

export function shortNpub(npub: string, len = 8) {
  if (npub.length <= len * 2 + 1) return npub;
  return `${npub.slice(0, len)}…${npub.slice(-len)}`;
}
