'use client';

// Reconcile the user's local mute-list cache with their NIP-51 kind:10000
// event on Nostr. Mirrors lib/nostr/favorites-hydrator.ts.

import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { fetchMutedPubkeys, schedulePublishMuteList } from './mutes';
import { resolvePublishRelays } from './relays';
import type { NostrIdentity } from './auth';

/**
 * Reconcile local mute-list cache with the NIP-51 kind:10000 event.
 * Last-write-wins on `event.created_at` (s) vs local cache `updatedAt` (s).
 * If Nostr is newer (or local is empty), adopt the relay set; if local is
 * newer, push it back up via a debounced publish so other clients catch up.
 *
 * Non-`p` tags (e.g. `e`, `t`, `word`) on the relay event are preserved into
 * the local cache so a future republish from this app doesn't clobber mutes
 * set in another client.
 */
export async function hydrateMutes(identity: NostrIdentity): Promise<void> {
  const setMutedPubkeys = useApp.getState().setMutedPubkeys;
  const cached = storage.muted.get(identity.npub);
  const muteEvent = await fetchMutedPubkeys(identity.pubkey);

  if (!muteEvent) {
    // No Nostr event yet; if we have local mutes, push them up so the user's
    // first mute on a different device doesn't disappear next time we hydrate.
    if (cached.pubkeys.length > 0) {
      setMutedPubkeys(new Set(cached.pubkeys));
      schedulePublishMuteList(
        () => Array.from(useApp.getState().mutedPubkeys),
        () => storage.muted.get(identity.npub).otherTags,
        resolvePublishRelays(identity),
      );
    }
    return;
  }

  const nostrNewer = muteEvent.updatedAt >= cached.updatedAt;
  if (nostrNewer) {
    storage.muted.set(identity.npub, {
      pubkeys: muteEvent.pubkeys,
      otherTags: muteEvent.otherTags,
      updatedAt: muteEvent.updatedAt,
    });
    setMutedPubkeys(new Set(muteEvent.pubkeys));
  } else {
    // Local is ahead — keep the cache as-is but make sure the otherTags from
    // the relay event are merged in case the user added a hashtag mute on
    // another client we haven't yet seen reflected locally.
    storage.muted.set(identity.npub, {
      pubkeys: cached.pubkeys,
      otherTags: muteEvent.otherTags,
      updatedAt: cached.updatedAt,
    });
    setMutedPubkeys(new Set(cached.pubkeys));
    schedulePublishMuteList(
      () => Array.from(useApp.getState().mutedPubkeys),
      () => storage.muted.get(identity.npub).otherTags,
      resolvePublishRelays(identity),
    );
  }
}
