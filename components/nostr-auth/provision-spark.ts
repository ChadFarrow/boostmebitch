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
 * Best-effort in the sense that sign-in must complete even if the SDK or the
 * backup publish fails — but the caller logs the failure rather than dropping
 * it on the floor. A silently swallowed rejection here is indistinguishable
 * from "the wallet is still initializing", and cost a full debugging session
 * once already.
 */
export async function provisionSparkFromKey(
  skHex: string,
  identity: NostrIdentity,
): Promise<void> {
  // Something already connected a wallet mid-flow; don't fight it.
  if (hasSpark()) return;

  // `bmb:spark:opted_out` is deliberately NOT honored here, and this is the one
  // place that's correct. The flag is global (one key, not per-npub), so it
  // records "some identity on this device turned Spark off" — but this runs
  // only on the brand-new-account branch, for a key generated seconds ago that
  // has never had a wallet of any kind. Honoring another identity's decision
  // here silently left new users with no wallet at all, which is the opposite
  // of the intent: a Google signup is supposed to come with a working boost
  // rail. Clearing it also restores the invariant every other Spark connect
  // path holds (spark-wallet.tsx clears it on create/paste/restore) — leaving
  // it set while Spark is connected would make the next login's silent restore
  // skip a wallet that IS connected.
  //
  // This does not fight rule 2 ("their wallet unless they connect a different
  // one"): if the user later connects NWC/WebLN, clearOtherWallets sets the
  // flag again and Spark stops auto-restoring.
  storage.sparkOptOut.clear();

  const mnemonic = await sparkMnemonicFromKey(skHex);
  await sparkInitFromMnemonic({ mnemonic, ownerPubkey: identity.pubkey });

  // Back the seed up the same way every other Spark connect path does, so the
  // wallet restores on the user's other devices. A brand-new npub has no prior
  // kind:30078, so there's nothing here to overwrite.
  await publishEncryptedMnemonic(identity, mnemonic);
}
