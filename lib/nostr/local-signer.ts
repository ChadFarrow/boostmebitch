'use client';

// A signer backed by a secret key this app holds itself, rather than by an
// external signer (NIP-07 extension, Amber, NIP-46 bunker). Installed onto
// window.nostr by lib/nostr/signer.ts, so the rest of the codebase — which
// only ever reads window.nostr — needs no changes.
//
// This exists for the Google-onboarding path: a user with no Nostr identity
// gets a freshly generated key, and something has to sign with it. Every
// other signer keeps the key out of our process; this one can't, which is why
// the key at rest lives in lib/nostr/local-key-store.ts behind a
// non-extractable CryptoKey rather than in localStorage.
//
// nip44 is not optional here despite being optional on the Window['nostr']
// shape: the Spark mnemonic backup, the synced-settings event, and the NWC
// backup all require it, and a Google-onboarded user is exactly the user who
// will hit all three.

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { nip04, nip44, type Event, type EventTemplate } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';

export class LocalSigner {
  private sk: Uint8Array;
  private pk: string;

  constructor(skHex: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(skHex)) {
      throw new Error('Local signer requires a 32-byte hex secret key');
    }
    this.sk = hexToBytes(skHex);
    this.pk = getPublicKey(this.sk);
  }

  async getPublicKey(): Promise<string> {
    return this.pk;
  }

  async signEvent(template: EventTemplate): Promise<Event> {
    return finalizeEvent(template, this.sk);
  }

  nip04 = {
    encrypt: async (pubkey: string, plaintext: string) =>
      nip04.encrypt(this.sk, pubkey, plaintext),
    decrypt: async (pubkey: string, ciphertext: string) =>
      nip04.decrypt(this.sk, pubkey, ciphertext),
  };

  nip44 = {
    encrypt: async (pubkey: string, plaintext: string) =>
      nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(this.sk, pubkey)),
    decrypt: async (pubkey: string, ciphertext: string) =>
      nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(this.sk, pubkey)),
  };

  /** Hex secret key. Only for the backup/export paths — never log or transmit. */
  secretKeyHex(): string {
    return Array.from(this.sk, (b) => b.toString(16).padStart(2, '0')).join('');
  }
}
