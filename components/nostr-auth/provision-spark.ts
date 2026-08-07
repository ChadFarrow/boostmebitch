'use client';

import { publishEncryptedMnemonic, type NostrIdentity } from '@/lib/nostr';
import { getKey } from '@/lib/nostr/local-key-store';
import {
  hasSpark,
  sparkInitFromMnemonic,
  sparkMnemonicFromKey,
  sparkSeedIsActive,
} from '@/lib/v4v/spark';
import { storage } from '@/lib/storage';

/**
 * Bring a local-signer account's Spark wallet up without waiting on the
 * network, and return the mnemonic it used (null when it didn't run).
 *
 * The normal restore path is: query relays for the kind:30078 backup → NIP-44
 * decrypt → load the SDK → initialize. The relay query alone is capped at 8s
 * and is the slowest, most variable link, which is why a returning user sits
 * in front of a "connecting" wallet for several seconds.
 *
 * For a local signer none of that is necessary. We hold the key, and the seed
 * is a pure function of it (`sparkMnemonicFromKey`), so the wallet can be
 * derived in microseconds and the SDK started immediately. This is the same
 * model Wisp uses — its derived wallet is the DEFAULT wallet, reachable from
 * the nsec alone on a fresh install with no relay backup at all; the backup
 * exists for wallets that differ from that default.
 *
 * Which is exactly why this is a fast path and not the source of truth: a user
 * who pasted their own Spark seed has a kind:30078 backup that differs, and
 * that backup must still win. The caller races this against the fetch and
 * re-inits if they disagree.
 *
 * The key is read straight from the key store rather than from the signer:
 * `LocalSigner` deliberately exposes no key-export method, because anything
 * that reaches `window.nostr` is readable by every script on the origin.
 */
export async function deriveSparkFromLocalKey(
  identity: NostrIdentity,
): Promise<string | null> {
  if (storage.signer.get() !== 'local') return null;
  if (hasSpark() || storage.sparkOptOut.get(identity.npub)) return null;

  const skHex = await getKey();
  if (!skHex) return null;
  const mnemonic = await sparkMnemonicFromKey(skHex);

  // Re-check: the IndexedDB read and the derivation both await, and the wallet
  // modal is reachable throughout. Don't init over a wallet the user connected
  // in the meantime.
  if (hasSpark()) return null;
  await sparkInitFromMnemonic({ mnemonic, ownerPubkey: identity.pubkey });
  return mnemonic;
}

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

  // Record "this account wants Spark" FIRST, before any await.
  //
  // The opt-out flag is per-npub, so a brand-new key has no opinion recorded
  // and this function doesn't need to consult it — nobody has ever turned Spark
  // off for THIS account. (When the flag was device-global, this function had
  // to choose between honoring another identity's decision, which left new
  // users with no wallet, and clearing it, which resurrected Spark for the
  // identity that turned it off. Neither was right; scoping the flag dissolved
  // the choice.)
  //
  // Historically that wasn't enough on its own. We're called fire-and-forget,
  // and the caller reaches onSuccess -> completeSignIn -> loadProfile ->
  // deriveSparkFromLocalKey long before the SDK handshake below resolves. That
  // path DOES read the flag, and `storage.sparkOptOut.get` used to fall back to
  // the pre-per-npub global `bmb:spark:opted_out` when an npub had no scoped
  // value — so on any device where some earlier identity turned Spark off, a
  // brand-new account inherited that opt-out. THAT FALLBACK IS GONE: `get`
  // reads the scoped key only, and the bare global is dead and never read.
  //
  // Writing the '0' here early still earns its keep on the remaining reason: it
  // makes a failed init retryable. It used to be written after
  // sparkInitFromMnemonic, on the reasoning that an SDK failure shouldn't leave
  // "wants Spark" recorded for a wallet that never came up — but that's the
  // wrong trade. '0' only means "has not opted out", which for a brand-new
  // account is simply true, and recording it means the next login's
  // deriveSparkFromLocalKey tries again instead of finding a stale '1' and
  // silently refusing to bring the wallet up forever.
  storage.sparkOptOut.clear(identity.npub);

  const mnemonic = await sparkMnemonicFromKey(skHex);

  // Re-check immediately before each side effect. Provisioning is fire-and-
  // forget and spans seconds of SDK handshake and a relay publish, during
  // which the user can open the wallet modal and paste their own seed. Without
  // these, the derived wallet replaces the one they just connected and — worse
  // — the publish below overwrites their real kind:30078 backup, which is
  // replaceable and therefore unrecoverable.
  if (hasSpark()) return;
  await sparkInitFromMnemonic({ mnemonic, ownerPubkey: identity.pubkey });

  // Back the seed up the same way every other Spark connect path does, so the
  // wallet restores on the user's other devices. A brand-new npub has no prior
  // kind:30078, so there's nothing here to overwrite.
  //
  // Guard on the wallet still being OURS rather than on hasSpark() — after the
  // init above hasSpark() is unconditionally true, so it would prove nothing.
  // If the user pasted their own seed while the SDK handshake was running,
  // theirs is the active wallet and publishing here would replace their real
  // backup with the derived one. kind:30078 is replaceable: that loss is
  // permanent.
  if (!sparkSeedIsActive(mnemonic)) return;
  await publishEncryptedMnemonic(identity, mnemonic);
}
