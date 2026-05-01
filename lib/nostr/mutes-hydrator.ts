'use client';

// Reconcile the user's local mute-list cache with their NIP-51 kind:10000
// event on Nostr. Mirrors lib/nostr/favorites-hydrator.ts.
//
// The state here covers both public p-tags and (best-effort) NIP-04
// private p-tags — see lib/nostr/mutes.ts for the encoding details.

import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import {
  emptyMuteState,
  fetchMutedPubkeys,
  schedulePublishMuteList,
  unionMutedPubkeys,
  type MuteListState,
} from './mutes';
import { resolvePublishRelays } from './relays';
import type { NostrIdentity } from './auth';

/**
 * Reconcile local mute-list cache with the NIP-51 kind:10000 event.
 * Last-write-wins on `event.created_at` (s) vs local cache `updatedAt` (s).
 *
 * On adoption from Nostr we replace the entire local state including the
 * private list (decrypted via window.nostr.nip04 when available). When the
 * local cache is ahead, we merge the relay's other-tags into local so we
 * don't drop hashtag/keyword mutes from another client, then republish.
 */
export async function hydrateMutes(identity: NostrIdentity): Promise<void> {
  const setMutedPubkeys = useApp.getState().setMutedPubkeys;
  const cached = storage.muted.get(identity.npub);
  const muteEvent = await fetchMutedPubkeys(identity.pubkey);

  if (!muteEvent) {
    // No Nostr event yet; if we have a local cache, push it up so the user's
    // first mute on a different device doesn't disappear next time we hydrate.
    const hasLocal =
      cached.publicPubkeys.length > 0 ||
      cached.privatePubkeys.length > 0 ||
      !!cached.unreadablePrivateContent;
    if (hasLocal) {
      setMutedPubkeys(unionMutedPubkeys(cached));
      schedulePublishMuteList(
        identity.pubkey,
        () => storage.muted.get(identity.npub),
        resolvePublishRelays(identity),
      );
    } else {
      // Make sure the store reflects an empty state for this identity.
      setMutedPubkeys(new Set());
    }
    return;
  }

  const nostrNewer = muteEvent.updatedAt >= cached.updatedAt;
  if (nostrNewer) {
    storage.muted.set(identity.npub, muteEvent);
    setMutedPubkeys(unionMutedPubkeys(muteEvent));
  } else {
    // Local is ahead. Keep our pubkeys + non-`p` tags, but adopt the relay's
    // non-`p` tags too so cross-client hashtag mutes survive.
    const merged: MuteListState = {
      publicPubkeys: cached.publicPubkeys,
      publicOtherTags: muteEvent.publicOtherTags,
      privatePubkeys: cached.privatePubkeys,
      privateOtherTags: muteEvent.privateOtherTags,
      unreadablePrivateContent: cached.unreadablePrivateContent ?? muteEvent.unreadablePrivateContent,
      updatedAt: cached.updatedAt,
    };
    storage.muted.set(identity.npub, merged);
    setMutedPubkeys(unionMutedPubkeys(merged));
    schedulePublishMuteList(
      identity.pubkey,
      () => storage.muted.get(identity.npub),
      resolvePublishRelays(identity),
    );
  }
}

// Re-export so `lib/store.ts` can build an empty state for guest users
// without dragging in the full module.
export { emptyMuteState };
