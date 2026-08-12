'use client';

// The glue between the store's two favorite maps and the one shared kind:30003
// list on Nostr. Kept apart from `favorites.ts` so that module stays pure wire
// format + merge (and stays pinnable by scripts/check-favsync.mjs), and apart
// from `favorites-hydrator.ts` so <FavHeart> doesn't have to import the
// hydration path just to schedule a publish.

import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { resolvePublishRelays } from './relays';
import {
  itemId,
  scheduleSyncFavorites,
  showId,
  syncFavorites,
  type SharedFavoriteItem,
  type SyncOptions,
} from './favorites';
import type { NostrIdentity } from './auth';

/**
 * This device's favorites as wire items — both maps in one list, because they
 * share one Nostr event. Shows carry the feed URL as the NIP-73 hint; episodes
 * additionally carry their parent feed, without which an item guid can't be
 * resolved through PI.
 */
export function localFavoriteItems(): SharedFavoriteItem[] {
  const state = useApp.getState();
  const items: SharedFavoriteItem[] = [];
  for (const fav of Object.values(state.favorites)) {
    items.push({ id: showId(fav.podcastGuid), feedUrl: fav.url });
  }
  for (const ep of Object.values(state.favoriteEpisodes)) {
    items.push({
      id: itemId(ep.itemGuid),
      feedUrl: ep.feedUrl,
      feedRef: ep.feedGuid ? showId(ep.feedGuid) : undefined,
    });
  }
  return items;
}

export function syncOptionsFor(identity: NostrIdentity): SyncOptions {
  return {
    pubkey: identity.pubkey,
    relays: resolvePublishRelays(identity),
    // Getters, not values: the debounce re-reads at fire time, so a burst of
    // heart-taps publishes once with the final set.
    local: localFavoriteItems,
    lastSynced: () => storage.favSynced.get(identity.npub),
    onSynced: (ids) => storage.favSynced.set(identity.npub, ids),
  };
}

/** Debounced read-merge-publish. Signed out, favorites stay local — no-op. */
export function requestFavoritesSync(identity: NostrIdentity | null | undefined) {
  if (!identity) return;
  scheduleSyncFavorites(syncOptionsFor(identity));
}

/** Immediate read-merge-publish, for callers that must await the result. */
export function syncFavoritesNow(identity: NostrIdentity) {
  return syncFavorites(syncOptionsFor(identity));
}
