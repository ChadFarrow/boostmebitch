'use client';

// Nostr-backed cross-device sync for the Inbox seen-state + listen queue. Same
// NIP-78 + NIP-44 encrypted-to-self pattern as settings-backup.ts, two separate
// replaceable events:
//   - kind:30078, d:'boostmebitch:inbox' → { seen: string[] }        (union merge)
//   - kind:30078, d:'boostmebitch:queue' → { items, updatedAt }       (newest-wins)
// Encrypted-to-self even though not secret — one uniform pattern with the
// settings/wallet backups. Gated on a NIP-44 signer; the schedule* helpers no-op
// without one so callers don't have to check.

import { FEED_QUERY_MAX_WAIT_MS } from './pool';
import { signAndPublish } from './publish';
import { fetchLatestEvent } from './event-queries';
import { DEFAULT_RELAYS, resolvePublishRelays } from './relays';
import { requireNip44, getNip44 } from './signer';
import { createScheduledPublish } from './debounced-publish';
import type { NostrIdentity } from './auth';
import type { QueueItem } from '../store';

const NIP44_DECRYPT_TIMEOUT_MS = 10_000;
function decryptWithTimeout(pubkey: string, ciphertext: string): Promise<string> {
  return Promise.race([
    requireNip44().decrypt(pubkey, ciphertext),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('nip44 decrypt timed out')), NIP44_DECRYPT_TIMEOUT_MS),
    ),
  ]);
}

export const INBOX_KIND = 30078;
export const INBOX_SEEN_D_TAG = 'boostmebitch:inbox';
export const LISTEN_QUEUE_D_TAG = 'boostmebitch:queue';
// The Inbox only ever looks back 30 days, so the synced seen set is capped to
// bound event size. JS Set→array preserves insertion order, so slice(-CAP)
// keeps the most-recently-marked keys.
const SEEN_CAP = 2000;

// Union of intended publish relays + DEFAULT_RELAYS (deduped, capped) so a fresh
// sign-in that hasn't hydrated NIP-65 yet still finds a backup. Mirrors
// settings-backup.ts:readRelays.
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

/** Decrypt the user's synced seen keys, or null if none / unreadable. */
export async function fetchInboxSeen(identity: NostrIdentity): Promise<string[] | null> {
  const event = await fetchLatestEvent(
    readRelays(identity),
    { kinds: [INBOX_KIND], authors: [identity.pubkey], '#d': [INBOX_SEEN_D_TAG], limit: 1 },
    FEED_QUERY_MAX_WAIT_MS,
  );
  if (!event || !event.content) return null;
  try {
    const parsed = JSON.parse(await decryptWithTimeout(identity.pubkey, event.content));
    return Array.isArray(parsed?.seen)
      ? parsed.seen.filter((x: unknown): x is string => typeof x === 'string')
      : null;
  } catch {
    return null;
  }
}

/** Encrypt-to-self and publish the seen set (replaceable), capped to newest N. */
export async function publishInboxSeen(identity: NostrIdentity, keys: string[]): Promise<void> {
  const capped = keys.slice(-SEEN_CAP);
  const ciphertext = await requireNip44().encrypt(identity.pubkey, JSON.stringify({ seen: capped }));
  await signAndPublish(
    { kind: INBOX_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['d', INBOX_SEEN_D_TAG]], content: ciphertext },
    resolvePublishRelays(identity),
  );
}

/** Decrypt the user's synced queue, or null if none / unreadable. */
export async function fetchListenQueue(
  identity: NostrIdentity,
): Promise<{ items: QueueItem[]; updatedAt: number } | null> {
  const event = await fetchLatestEvent(
    readRelays(identity),
    { kinds: [INBOX_KIND], authors: [identity.pubkey], '#d': [LISTEN_QUEUE_D_TAG], limit: 1 },
    FEED_QUERY_MAX_WAIT_MS,
  );
  if (!event || !event.content) return null;
  try {
    const parsed = JSON.parse(await decryptWithTimeout(identity.pubkey, event.content));
    const items: QueueItem[] = Array.isArray(parsed?.items)
      ? parsed.items.filter((i: { episode?: unknown; podcast?: unknown }) => i?.episode && i?.podcast)
      : [];
    const updatedAt = typeof parsed?.updatedAt === 'number' ? parsed.updatedAt : event.created_at * 1000;
    return { items, updatedAt };
  } catch {
    return null;
  }
}

/** Encrypt-to-self and publish the queue snapshot (replaceable). */
export async function publishListenQueue(
  identity: NostrIdentity,
  items: QueueItem[],
  updatedAt: number,
): Promise<void> {
  const ciphertext = await requireNip44().encrypt(identity.pubkey, JSON.stringify({ items, updatedAt }));
  await signAndPublish(
    { kind: INBOX_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['d', LISTEN_QUEUE_D_TAG]], content: ciphertext },
    resolvePublishRelays(identity),
  );
}

const scheduleSeen = createScheduledPublish('inbox-seen');
const scheduleQueue = createScheduledPublish('listen-queue');

/** Debounced seen publish — no-op without a NIP-44 signer. */
export function scheduleInboxSeenSync(identity: NostrIdentity, seen: Set<string>): void {
  if (!getNip44()) return;
  const keys = [...seen];
  scheduleSeen(() => publishInboxSeen(identity, keys));
}

/** Debounced queue publish — no-op without a NIP-44 signer. */
export function scheduleListenQueueSync(identity: NostrIdentity, items: QueueItem[], updatedAt: number): void {
  if (!getNip44()) return;
  const snapshot = items.slice();
  scheduleQueue(() => publishListenQueue(identity, snapshot, updatedAt));
}
