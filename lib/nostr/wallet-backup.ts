'use client';

// Nostr-backed encrypted backup for the Spark wallet mnemonic.
//
// Storage shape:
//   - kind: 30078 (NIP-78, application-specific data)
//   - d-tag: 'boostmebitch:wallet:spark' — stable identifier, replaceable
//   - content: NIP-44 v2 encrypted-to-self ciphertext of the BIP-39 mnemonic
//
// Trust model: anyone with the user's nsec can decrypt this (same trust
// boundary as login). The Nostr backup is convenience, not the only copy —
// callers must show the mnemonic once on first generation so the user can
// also write it down.
//
// Why kind:30078 and not NIP-60 (kind:17375): NIP-60 is Cashu-specific. We
// own the schema here; sticking to NIP-78 keeps it explicit that this is
// boostmebitch app data, not a portable Cashu wallet.

import { withPool } from './pool';
import { signAndPublish, type PublishedNote } from './publish';
import { resolvePublishRelays } from './relays';
import type { NostrIdentity } from './auth';

export const WALLET_BACKUP_KIND = 30078;
export const WALLET_BACKUP_D_TAG = 'boostmebitch:wallet:spark';

function ensureNip44() {
  if (typeof window === 'undefined' || !window.nostr?.nip44) {
    throw new Error(
      'Nostr signer does not expose NIP-44. Use Alby or nos2x with NIP-44 support.',
    );
  }
  return window.nostr.nip44;
}

/** Decrypt the user's stored mnemonic, or null if no backup exists yet. */
export async function fetchEncryptedMnemonic(
  identity: NostrIdentity,
): Promise<string | null> {
  const relays = resolvePublishRelays(identity);
  const event = await withPool(relays, async (pool) => {
    const events = await pool.querySync(relays, {
      kinds: [WALLET_BACKUP_KIND],
      authors: [identity.pubkey],
      '#d': [WALLET_BACKUP_D_TAG],
      limit: 1,
    });
    if (!events.length) return null;
    return events.sort((a, b) => b.created_at - a.created_at)[0];
  });
  if (!event || !event.content) return null;

  const nip44 = ensureNip44();
  return nip44.decrypt(identity.pubkey, event.content);
}

/** Encrypt-to-self and publish a new wallet backup event. */
export async function publishEncryptedMnemonic(
  identity: NostrIdentity,
  mnemonic: string,
): Promise<PublishedNote> {
  const nip44 = ensureNip44();
  const ciphertext = await nip44.encrypt(identity.pubkey, mnemonic);

  return signAndPublish(
    {
      kind: WALLET_BACKUP_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', WALLET_BACKUP_D_TAG]],
      content: ciphertext,
    },
    resolvePublishRelays(identity),
  );
}
