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
import { DEFAULT_RELAYS, resolvePublishRelays } from './relays';
import { requireNip44, getNip44 } from './signer';
import { createScheduledPublish } from './debounced-publish';
import { storage, type RailPref } from '../storage';
import type { NostrIdentity } from './auth';

const NIP44_DECRYPT_TIMEOUT_MS = 10_000;
function decryptWithTimeout(pubkey: string, ciphertext: string): Promise<string> {
  return Promise.race([
    requireNip44().decrypt(pubkey, ciphertext),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('nip44 decrypt timed out')), NIP44_DECRYPT_TIMEOUT_MS),
    ),
  ]);
}

export const SETTINGS_KIND = 30078;
export const SETTINGS_D_TAG = 'boostmebitch:settings';

export interface SyncedSettings {
  railPref?: RailPref;
}

// Union of intended publish relays + DEFAULT_RELAYS (deduped, capped) so a
// fresh sign-in that hasn't hydrated NIP-65 yet still finds a backup written
// from a session that had write relays. Mirrors wallet-backup.ts:readRelays.
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

function isRail(v: unknown): v is RailPref {
  return v === 'nwc' || v === 'spark' || v === 'webln';
}

/** Decrypt the user's synced settings, or null if none exist / unreadable. */
export async function fetchSettings(
  identity: NostrIdentity,
): Promise<SyncedSettings | null> {
  const event = await fetchLatestEvent(
    readRelays(identity),
    { kinds: [SETTINGS_KIND], authors: [identity.pubkey], '#d': [SETTINGS_D_TAG], limit: 1 },
    FEED_QUERY_MAX_WAIT_MS,
  );
  if (!event || !event.content) return null;
  try {
    const parsed = JSON.parse(await decryptWithTimeout(identity.pubkey, event.content));
    return { railPref: isRail(parsed?.railPref) ? parsed.railPref : undefined };
  } catch {
    return null;
  }
}

/** Encrypt-to-self and publish the settings event (replaceable). */
export async function publishSettings(
  identity: NostrIdentity,
  settings: SyncedSettings,
): Promise<void> {
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
