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

import { withPool, FEED_QUERY_MAX_WAIT_MS } from './pool';
import { signAndPublish, type PublishedNote } from './publish';
import { DEFAULT_RELAYS, resolvePublishRelays } from './relays';
import { requireNip44 } from './signer';
import type { NostrIdentity } from './auth';

// Read-side relay set for the wallet backup. We always query the union of
// the user's intended publish relays AND DEFAULT_RELAYS, capped at 20.
//
// Why a union (not just resolvePublishRelays): on a fresh sign-in via
// Amber on Android, NIP-65 (kind:10002) hydrates in parallel with everything
// else inside `loadProfile`. If the user taps "Restore from Nostr" before
// that resolves, `identity.writeRelays` is still undefined and
// resolvePublishRelays falls back to DEFAULT_RELAYS. If the backup was
// originally published from a session that *had* writeRelays, it might live
// only on the user's outbox — and we'd miss it. Querying both sides covers
// either case without weakening the publish path, which still targets only
// the user's intended write relays.
function readRelays(identity: NostrIdentity): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of resolvePublishRelays(identity)) {
    if (!seen.has(r)) { seen.add(r); out.push(r); }
  }
  for (const r of DEFAULT_RELAYS) {
    if (!seen.has(r)) { seen.add(r); out.push(r); }
  }
  return out.slice(0, 20);
}

export const WALLET_BACKUP_KIND = 30078;
export const WALLET_BACKUP_D_TAG = 'boostmebitch:wallet:spark';

/** Decrypt the user's stored mnemonic, or null if no backup exists yet. */
export async function fetchEncryptedMnemonic(
  identity: NostrIdentity,
): Promise<string | null> {
  const relays = readRelays(identity);
  const event = await withPool(relays, async (pool) => {
    const events = await pool.querySync(relays, {
      kinds: [WALLET_BACKUP_KIND],
      authors: [identity.pubkey],
      '#d': [WALLET_BACKUP_D_TAG],
      limit: 1,
    }, { maxWait: FEED_QUERY_MAX_WAIT_MS });
    if (!events.length) return null;
    return events.sort((a, b) => b.created_at - a.created_at)[0];
  });
  if (!event || !event.content) return null;

  return requireNip44().decrypt(identity.pubkey, event.content);
}

/** Encrypt-to-self and publish a new wallet backup event. */
export async function publishEncryptedMnemonic(
  identity: NostrIdentity,
  mnemonic: string,
): Promise<PublishedNote> {
  const ciphertext = await requireNip44().encrypt(identity.pubkey, mnemonic);

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
