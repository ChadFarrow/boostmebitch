// NIP-07 sign-in. The window globals declared here cover both the Nostr
// signer and the WebLN provider (Lightning lib in @/lib/v4v/webln also uses
// it via this same module-level declaration).

import { nip19, type Event, type EventTemplate } from 'nostr-tools';

declare global {
  interface Window {
    nostr?: {
      getPublicKey: () => Promise<string>;
      signEvent: (e: EventTemplate) => Promise<Event>;
      nip04?: {
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

export function shortNpub(npub: string, len = 8) {
  if (npub.length <= len * 2 + 1) return npub;
  return `${npub.slice(0, len)}…${npub.slice(-len)}`;
}
