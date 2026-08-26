'use client';

// Nostr-backed sync for non-sensitive user preferences (currently the
// last-used boost rail). Same NIP-78 + NIP-44 encrypted-to-self pattern as
// the wallet backup (lib/nostr/wallet-backup.ts), separate d-tag.
//
//   - kind: 30078 (NIP-78, application-specific data)
//   - d-tag: 'boostmebitch:settings' — stable, replaceable
//   - content: NIP-44 v2 encrypted-to-self JSON of SyncedSettings
//
// Encrypted even though the payload isn't secret: it keeps one uniform
// pattern with the wallet backup and lets future (possibly sensitive)
// settings join the same event without a schema change.

import { FEED_QUERY_MAX_WAIT_MS } from './pool';
import { signAndPublish } from './publish';
import { fetchLatestEvent } from './event-queries';
import { backupReadRelays, resolvePublishRelays } from './relays';
import { requireNip44, getNip44, decryptWithTimeout, type DecryptPurpose } from './signer';
import { createScheduledPublish } from './debounced-publish';
import { storage, type RailPref } from '../storage';
import type { FavoritesPrivacy } from './favorites-list';
import type { NostrIdentity } from './auth';

export const SETTINGS_KIND = 30078;
export const SETTINGS_D_TAG = 'boostmebitch:settings';

export interface SyncedSettings {
  railPref?: RailPref;
  /**
   * Where this account's favorites go — see `lib/nostr/favorites-list.ts`.
   *
   * It rides here so a phone set to Private stops a laptop publishing the same
   * list in plaintext. It is a CORROBORATOR, not the authority: the kind:10333
   * event itself says which half the entries are in, and `seedFavoritesMode`
   * reads that. This carries the two answers the wire cannot state — 'off', and
   * the choice made by an account whose list is still empty.
   */
  favPrivacy?: FavoritesPrivacy;
}

function isRail(v: unknown): v is RailPref {
  return v === 'nwc' || v === 'spark' || v === 'webln';
}

function isPrivacy(v: unknown): v is FavoritesPrivacy {
  return v === 'public' || v === 'private' || v === 'off';
}

/**
 * This device's whole view of the synced settings.
 *
 * Every publish sends the FULL object, built from local state, rather than the
 * one field the caller happens to be changing. `publishSettings` used to send
 * `{ railPref }` alone, which was correct only while `railPref` was the only
 * field there could ever be — the moment a second one exists, a boost publishes
 * `{ railPref }` over it and silently un-sets the user's privacy choice on
 * every other device.
 *
 * Built from local state rather than from a relay read on purpose: a read needs
 * a decrypt, `recordLastRail` fires right after a payment, and an approval
 * sheet there is the last thing anyone wants. Local state is this device's best
 * knowledge and is refreshed by `applySyncedSettings` on every page load.
 */
function localSettings(npub: string): SyncedSettings {
  const rail = storage.railPref.get();
  const privacy = storage.favPrivacy.get(npub);
  return {
    ...(rail ? { railPref: rail } : {}),
    ...(privacy ? { favPrivacy: privacy } : {}),
  };
}

/** Write what a relay told us into this device's local state. */
export function applySyncedSettings(npub: string, settings: SyncedSettings | null): void {
  if (!settings) return;
  if (settings.railPref) storage.railPref.set(settings.railPref);
  if (settings.favPrivacy) storage.favPrivacy.set(npub, settings.favPrivacy);
}

/** Decrypt the user's synced settings, or null if none exist / unreadable. */
export async function fetchSettings(
  identity: NostrIdentity,
  purpose: DecryptPurpose,
): Promise<SyncedSettings | null> {
  const event = await fetchLatestEvent(
    backupReadRelays(identity),
    { kinds: [SETTINGS_KIND], authors: [identity.pubkey], '#d': [SETTINGS_D_TAG], limit: 1 },
    FEED_QUERY_MAX_WAIT_MS,
  );
  if (!event || !event.content) return null;
  try {
    const parsed = JSON.parse(await decryptWithTimeout(identity.pubkey, event.content, purpose));
    return {
      railPref: isRail(parsed?.railPref) ? parsed.railPref : undefined,
      favPrivacy: isPrivacy(parsed?.favPrivacy) ? parsed.favPrivacy : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Encrypt-to-self and publish the settings event (replaceable).
 *
 * `patch` is merged over this device's whole view — see {@link localSettings}.
 * A caller that sends only its own field replaces the event with that field
 * alone, which un-sets every other one on every other device.
 */
export async function publishSettings(
  identity: NostrIdentity,
  patch: SyncedSettings,
): Promise<void> {
  const settings = { ...localSettings(identity.npub), ...patch };
  const ciphertext = await requireNip44().encrypt(
    identity.pubkey,
    JSON.stringify(settings),
  );
  await signAndPublish(
    {
      kind: SETTINGS_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', SETTINGS_D_TAG]],
      content: ciphertext,
    },
    resolvePublishRelays(identity),
  );
}

const scheduleSettings = createScheduledPublish('settings');

/**
 * Record the rail the user just paid with as their preference: always
 * locally, and — when signed in with a NIP-44-capable signer — debounced to
 * Nostr so it follows their npub across devices. No-op publish when the rail
 * is unchanged, signed out, or the signer can't encrypt.
 */
export function recordLastRail(rail: RailPref, identity: NostrIdentity | null): void {
  const changed = storage.railPref.get() !== rail;
  storage.railPref.set(rail);
  if (!changed || !identity || !getNip44()) return;
  scheduleSettings(() => publishSettings(identity, { railPref: rail }));
}

const scheduleFavPrivacy = createScheduledPublish('fav-privacy');

/**
 * Record where this account's favorites go: always locally, and — when signed
 * in with a NIP-44-capable signer — debounced to Nostr so the choice follows
 * the npub instead of the machine.
 *
 * Local first and unconditionally. The publish is best-effort: a signer that
 * cannot encrypt still gets a working setting on this device, and the kind:10333
 * event itself carries the answer for the case that matters most.
 */
export function recordFavoritesPrivacy(
  npub: string,
  privacy: FavoritesPrivacy,
  identity: NostrIdentity | null,
): boolean {
  const previous = storage.favPrivacy.get(npub);
  const landed = storage.favPrivacy.set(npub, privacy);
  if (!landed) {
    // Put it back, and publish nothing. `safeSet` mirrors a write it cannot
    // land into memory, so without this the choice silently applies for the
    // rest of the session and is gone on the next reload — and the caller has
    // just told the user nothing was changed. A half-applied privacy setting is
    // worse than a refused one: it is the state where the app and the user
    // disagree about where the next favorite goes.
    if (previous) storage.favPrivacy.set(npub, previous);
    else storage.favPrivacy.clear(npub);
    return false;
  }
  if (identity && identity.npub === npub && getNip44()) {
    scheduleFavPrivacy(() => publishSettings(identity, { favPrivacy: privacy }));
  }
  return true;
}
