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

import { FEED_QUERY_MAX_WAIT_MS } from './pool';
import { assertPublished, signAndPublish, type PublishedNote } from './publish';
import { fetchLatestEvent, fetchLatestEventDetailed } from './event-queries';
import { backupReadRelays, resolvePublishRelays } from './relays';
import { requireNip44, decryptWithTimeout } from './signer';
import type { NostrIdentity } from './auth';

export const WALLET_BACKUP_KIND = 30078;
export const WALLET_BACKUP_D_TAG = 'boostmebitch:wallet:spark';

/** Decrypt the user's stored mnemonic, or null if no backup exists yet. */
export async function fetchEncryptedMnemonic(
  identity: NostrIdentity,
): Promise<string | null> {
  return (await fetchEncryptedMnemonicDetailed(identity)).mnemonic;
}

/**
 * As {@link fetchEncryptedMnemonic}, but also reports whether the *absence* of
 * a backup can be trusted.
 *
 * Only one caller needs this, and it needs it badly: the login-time backfill in
 * `<NostrAuth>`'s doLoadProfile, which publishes a local signer's derived seed
 * when no backup exists. kind:30078 is REPLACEABLE — publishing at this
 * coordinate destroys whatever was there before, permanently. A plain null from
 * the relay query means "nobody had it" OR "nothing answered in time", and
 * acting on the second one would overwrite the backup of a user who pasted
 * their own (funded) Primal/Blitz seed with our derived default. That's the
 * general "never record an absence you didn't reliably observe" rule with money
 * attached, so the flag is mandatory rather than advisory.
 *
 * `trustworthy` comes straight from `fetchLatestEventDetailed`, which counts
 * per relay: an event in hand, or every relay we REACHED sent a real EOSE and
 * there was at least one. Relays that never connect leave the denominator, so a
 * total blackout reads as untrustworthy rather than as proof of absence — which
 * is the case that matters here. See `readIsTrustworthy` in `./read-trust`.
 * `sparkSeedIsActive` at the call site is the second half of the guard.
 *
 * The `expect` predicate is not belt-and-braces. This app writes THREE kind:30078
 * coordinates (`boostmebitch:wallet:spark`, `boostmebitch:wallet:nwc`, and the
 * settings d-tag), and `acceptsEvent`'s own note is that the moment two `d` tags
 * share one subscription — which the spec permits as the efficient implementation
 * — `matchFilters` accepts both and only a predicate can tell them apart. Reading
 * the NWC connection string as the seed backup, finding it "present", and so
 * skipping the backfill forever is a silent version of the bug this whole path
 * exists to fix.
 *
 * Note what is deliberately NOT caught: a decrypt failure or timeout on an event
 * that exists propagates as a rejection, exactly as the plain function has
 * always done. Folding it into `{ mnemonic: null, trustworthy: true }` would
 * feed the backfill the worst possible input — a backup demonstrably present
 * and unread — so the rejection is the safe answer.
 */
export async function fetchEncryptedMnemonicDetailed(
  identity: NostrIdentity,
): Promise<{ mnemonic: string | null; trustworthy: boolean }> {
  const { event, trustworthy } = await fetchLatestEventDetailed(
    backupReadRelays(identity),
    { kinds: [WALLET_BACKUP_KIND], authors: [identity.pubkey], '#d': [WALLET_BACKUP_D_TAG], limit: 1 },
    FEED_QUERY_MAX_WAIT_MS,
    { pubkey: identity.pubkey, kinds: [WALLET_BACKUP_KIND], dTag: WALLET_BACKUP_D_TAG },
  );
  // An event with empty content is a tombstone (the shape `deleteEncryptedNwc`
  // writes at the NWC coordinate; nothing writes one here today). It's the
  // user's own latest word on this coordinate, so it's a *reliable* absence —
  // trustworthy stays whatever the query reported, which is true by definition
  // once an event is in hand.
  if (!event || !event.content) return { mnemonic: null, trustworthy };

  return { mnemonic: await decryptWithTimeout(identity.pubkey, event.content, 'unattended'), trustworthy };
}

/**
 * Encrypt-to-self and publish a new wallet backup event.
 *
 * **Throws if the event reached no relay.** `signAndPublish` resolves once every
 * relay has SETTLED, accepted or not, so a total failure awaits cleanly and hands
 * back an empty `acceptedRelays` — which read as success here for as long as this
 * function existed. It bites hardest at provisioning: a seconds-old npub has no
 * kind:10002 yet, so `resolvePublishRelays` falls back to DEFAULT_RELAYS, and one
 * bad moment during signup left the account with a working derived wallet, no
 * backup, and nothing anywhere saying so.
 *
 * The assert lives HERE rather than at each call site because there are four
 * writers (both `<SparkWallet>` paths, `provisionSparkFromKey`, and the login
 * backfill) and four is four places to forget — the same rule the favorites
 * baseline learned the expensive way. Callers still choose what to do with the
 * throw; what they no longer get to do is not notice.
 */
export async function publishEncryptedMnemonic(
  identity: NostrIdentity,
  mnemonic: string,
): Promise<PublishedNote> {
  const ciphertext = await requireNip44().encrypt(identity.pubkey, mnemonic);

  return assertPublished(
    await signAndPublish(
      {
        kind: WALLET_BACKUP_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', WALLET_BACKUP_D_TAG]],
        content: ciphertext,
      },
      resolvePublishRelays(identity),
    ),
    'spark wallet backup',
  );
}

// ── NWC connection backup ──────────────────────────────────────────────
// Same kind:30078 + NIP-44 encrypted-to-self mechanism, different d-tag.
// Opt-in only (an NWC URI is a budgeted spending credential), and deletable
// via `deleteEncryptedNwc` when the user turns the backup off / disconnects.

export const WALLET_NWC_D_TAG = 'boostmebitch:wallet:nwc';

/** Decrypt the user's stored NWC URI, or null if no backup exists. */
export async function fetchEncryptedNwc(
  identity: NostrIdentity,
): Promise<string | null> {
  const event = await fetchLatestEvent(
    backupReadRelays(identity),
    { kinds: [WALLET_BACKUP_KIND], authors: [identity.pubkey], '#d': [WALLET_NWC_D_TAG], limit: 1 },
    FEED_QUERY_MAX_WAIT_MS,
  );
  if (!event || !event.content) return null;
  try {
    const parsed = JSON.parse(await decryptWithTimeout(identity.pubkey, event.content, 'unattended'));
    return typeof parsed?.uri === 'string' && parsed.uri ? parsed.uri : null;
  } catch {
    return null;
  }
}

/** Encrypt-to-self and publish the NWC connection backup. */
export async function publishEncryptedNwc(
  identity: NostrIdentity,
  uri: string,
): Promise<PublishedNote> {
  const ciphertext = await requireNip44().encrypt(identity.pubkey, JSON.stringify({ uri }));
  return signAndPublish(
    {
      kind: WALLET_BACKUP_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', WALLET_NWC_D_TAG]],
      content: ciphertext,
    },
    resolvePublishRelays(identity),
  );
}

/**
 * Tombstone the NWC backup: publish the same replaceable (kind+pubkey+d)
 * coordinate with empty content + a newer timestamp, so the latest version
 * carries no secret. (Relays SHOULD drop the superseded event; some may
 * retain it — the ciphertext stays decryptable only by the user's key.)
 */
export async function deleteEncryptedNwc(
  identity: NostrIdentity,
): Promise<PublishedNote> {
  return signAndPublish(
    {
      kind: WALLET_BACKUP_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', WALLET_NWC_D_TAG]],
      content: '',
    },
    resolvePublishRelays(identity),
  );
}
