'use client';

import { publishEncryptedMnemonic, type NostrIdentity } from '@/lib/nostr';
import { hasSpark, sparkInitFromMnemonic, sparkMnemonicFromKey } from '@/lib/v4v/spark';
import { storage } from '@/lib/storage';

/**
 * Give a brand-new Google-onboarded account a working boost rail, instead of
 * landing them on an empty wallet modal. Mirrors Wisp's "derive default wallet
 * from nsec during onboarding".
 *
 * Only ever called on the **new-account** branch. On restore the npub may
 * already have a Spark backup, and loadProfile's existing silent restore owns
 * that path — running this there could init a derived wallet over the user's
 * real one.
 *
 * Entirely best-effort: sign-in must complete even if the SDK or the backup
 * publish fails, so every failure here is swallowed by the caller.
 */
export async function provisionSparkFromKey(
  skHex: string,
  identity: NostrIdentity,
): Promise<void> {
  // The user turned Spark off on this device at some point — respect it, and
  // don't set the flag either way.
  if (storage.sparkOptOut.get()) return;
  // Something already connected a wallet mid-flow; don't fight it.
  if (hasSpark()) return;

  const mnemonic = await sparkMnemonicFromKey(skHex);
  await sparkInitFromMnemonic({ mnemonic, ownerPubkey: identity.pubkey });

  // Back the seed up the same way every other Spark connect path does, so the
  // wallet restores on the user's other devices. A brand-new npub has no prior
  // kind:30078, so there's nothing here to overwrite.
  await publishEncryptedMnemonic(identity, mnemonic);
}
