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
import { requireNip44, decryptWithTimeout, type DecryptPurpose } from './signer';
import { encodeAmberSafe, decodeAmberSafe } from './amber-safe-text';
import type { NostrIdentity } from './auth';

export const WALLET_BACKUP_KIND = 30078;
/**
 * NOT PER-BRAND, AND IT MUST NEVER BECOME PER-BRAND.
 *
 * A kind:30078 is ADDRESSABLE at `(pubkey, kind, d)`, and the pubkey is the
 * USER's — not the site's. So this address is the same coordinate whichever
 * deploy the user signed in on, and that is the property worth keeping: someone
 * who uses boostmebuddy.com on their phone and boostmebitch.com on a laptop
 * opens ONE wallet backup, not two.
 *
 * Branding this string would not migrate anything. It would point the new deploy
 * at an address nothing has ever written, and every existing backup would read
 * back as "No backup found on Nostr for this account" — intact, unreachable, and
 * reported as never having existed. That is the same failure `decodeAmberSafe`'s
 * legacy branch exists to prevent, arriving from a different direction.
 */
export const WALLET_BACKUP_D_TAG = 'boostmebitch:wallet:spark';

/** Decrypt the user's stored mnemonic, or null if no backup exists yet. */
export async function fetchEncryptedMnemonic(
  identity: NostrIdentity,
  purpose: DecryptPurpose,
): Promise<string | null> {
  return (await fetchEncryptedMnemonicDetailed(identity, purpose)).mnemonic;
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
  purpose: DecryptPurpose,
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

  return { mnemonic: await decryptWithTimeout(identity.pubkey, event.content, purpose), trustworthy };
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

/** Not per-brand either — see WALLET_BACKUP_D_TAG above for why. */
export const WALLET_NWC_D_TAG = 'boostmebitch:wallet:nwc';

/** Decrypt the user's stored NWC URI, or null if no backup exists. */
export async function fetchEncryptedNwc(
  identity: NostrIdentity,
  purpose: DecryptPurpose,
): Promise<string | null> {
  return (await fetchEncryptedNwcDetailed(identity, purpose)).uri;
}

/**
 * As {@link fetchEncryptedNwc}, but separates the three answers a caller with a
 * screen has to tell apart. All three used to be `null`.
 *
 *  - `{ uri: null, unreadable: false }` — nobody published a backup, or the
 *    latest event at the coordinate is `deleteEncryptedNwc`'s tombstone.
 *  - `{ uri: null, unreadable: true }` — an event IS there, it decrypted, and
 *    no connection string came out of it. That is a backup this account owns
 *    and cannot use, and the only repair is to publish over it.
 *  - a **throw** — the decrypt failed or timed out, so we learned nothing at
 *    all. Swallowing it into `null` reports a backup as absent on the strength
 *    of a signer that never answered, which is the general "never record an
 *    absence you didn't reliably observe" rule one layer down. Both unattended
 *    callers already `.catch`, so nothing regresses.
 *
 * The middle state is not hypothetical. Amber truncates a payload at the first
 * `?`, an NWC connection string always has one, and the encrypt step still
 * SUCCEEDS on the truncated text — so backups written from an Android device
 * before `encodeAmberSafe` shipped hold a prefix like
 * `{"uri":"nostr+walletconnect://<pubkey>` and nothing more. Reported as "no
 * backup found", that reads as the feature never having run; reported as
 * unreadable, it names the repair.
 */
export async function fetchEncryptedNwcDetailed(
  identity: NostrIdentity,
  purpose: DecryptPurpose,
): Promise<{ uri: string | null; unreadable: boolean }> {
  const event = await fetchLatestEvent(
    backupReadRelays(identity),
    { kinds: [WALLET_BACKUP_KIND], authors: [identity.pubkey], '#d': [WALLET_NWC_D_TAG], limit: 1 },
    FEED_QUERY_MAX_WAIT_MS,
  );
  if (!event || !event.content) return { uri: null, unreadable: false };
  // Deliberately outside the try below: a decrypt that fails or times out is
  // not a finding about the backup, so it propagates.
  const plaintext = await decryptWithTimeout(identity.pubkey, event.content, purpose);
  try {
    // Backups written before `encodeAmberSafe` shipped hold bare JSON, and they
    // are the ones a returning user has. `decodeAmberSafe` returns null for
    // anything without its prefix, which is the signal to read the plaintext
    // as-is — so both formats round-trip and no existing backup is orphaned.
    const parsed = JSON.parse(decodeAmberSafe(plaintext) ?? plaintext);
    const uri = typeof parsed?.uri === 'string' && parsed.uri ? parsed.uri : null;
    return { uri, unreadable: uri === null };
  } catch {
    return { uri: null, unreadable: true };
  }
}

/**
 * Encrypt-to-self and publish the NWC connection backup.
 *
 * **The plaintext goes through `encodeAmberSafe`, and that is a correctness
 * requirement rather than a style choice.** On Amber the encrypt is a NIP-55
 * round trip, the plaintext travels inside the `nostrsigner:` URI, and Amber
 * URL-decodes that URI before splitting it on `?`. An NWC connection string
 * always carries one — NIP-47 writes `nostr+walletconnect://<pubkey>?relay=…` —
 * so the raw JSON truncated at `?relay=` and Amber answered "Invalid request"
 * to every backup attempt ever made from an Android device. The failure was
 * total, silent from this side, and indistinguishable from "Amber didn't come
 * back". `fetchEncryptedNwc` reads both formats; see ./amber-safe-text.
 *
 * **Throws if the event reached no relay**, for the reason spelled out on
 * `publishEncryptedMnemonic`: `signAndPublish` resolves once every relay has
 * SETTLED, accepted or not, so a total failure awaits cleanly with an empty
 * `acceptedRelays`. Both callers record durable state on this promise resolving
 * — they set `bmb:nwc_backup:<npub>`, which is what the connected card renders
 * as "backed up" and what `disconnect` reads to decide whether a tombstone is
 * owed. Recording that against a publish nobody accepted tells the user their
 * spending credential is safe on relays when it is nowhere.
 */
export async function publishEncryptedNwc(
  identity: NostrIdentity,
  uri: string,
): Promise<PublishedNote> {
  const ciphertext = await requireNip44().encrypt(
    identity.pubkey,
    encodeAmberSafe(JSON.stringify({ uri })),
  );
  return assertPublished(
    await signAndPublish(
      {
        kind: WALLET_BACKUP_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', WALLET_NWC_D_TAG]],
        content: ciphertext,
      },
      resolvePublishRelays(identity),
    ),
    'NWC connection backup',
  );
}

/**
 * Tombstone the NWC backup: publish the same replaceable (kind+pubkey+d)
 * coordinate with empty content + a newer timestamp, so the latest version
 * carries no secret. (Relays SHOULD drop the superseded event; some may
 * retain it — the ciphertext stays decryptable only by the user's key.)
 *
 * **Throws if the tombstone reached no relay.** `disconnect` awaits this and
 * keeps the local connection on a throw so the user can retry; without the
 * assert a tombstone that reached nobody clears `bmb:nwc_backup:<npub>` anyway,
 * the credential stays live on relays, and the next sign-in on a device with no
 * local URI restores the very connection the user just disconnected.
 */
export async function deleteEncryptedNwc(
  identity: NostrIdentity,
): Promise<PublishedNote> {
  return assertPublished(
    await signAndPublish(
      {
        kind: WALLET_BACKUP_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', WALLET_NWC_D_TAG]],
        content: '',
      },
      resolvePublishRelays(identity),
    ),
    'NWC connection backup removal',
  );
}
