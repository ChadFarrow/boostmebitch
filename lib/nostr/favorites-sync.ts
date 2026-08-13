'use client';

// The glue between the store's two favorite maps and the one shared kind:30078
// list on Nostr. Kept apart from `favorites.ts` so that module stays pure wire
// format + merge (and stays pinnable by scripts/check-favsync.mjs), and apart
// from `favorites-hydrator.ts` so <FavHeart> doesn't have to import the
// hydration path just to schedule a publish.

import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { resolvePublishRelays } from './relays';
import { createScheduledPublish } from './debounced-publish';
import {
  itemFrom,
  itemId,
  showId,
  syncFavorites,
  type SharedFavoriteItem,
  type SyncOptions,
} from './favorites';
import type { NostrIdentity } from './auth';

/**
 * This device's favorites as wire items — both maps in one list, because they
 * share one Nostr event. Episodes carry their parent feed at position 3,
 * without which an item guid can't be resolved through PI.
 *
 * Neither carries a feed URL any more. `FavoritePodcast.url` and
 * `FavoriteEpisode.feedUrl` are still populated (from PI, and from legacy
 * position-2 values found on the wire) and still used for rendering — they just
 * no longer reach the wire. See `itemFrom`, which has no parameter for one.
 */
export function localFavoriteItems(): SharedFavoriteItem[] {
  const state = useApp.getState();
  const items: SharedFavoriteItem[] = [];
  for (const fav of Object.values(state.favorites)) {
    items.push(itemFrom({ id: showId(fav.podcastGuid), medium: fav.medium }));
  }
  for (const ep of Object.values(state.favoriteEpisodes)) {
    items.push(itemFrom({
      id: itemId(ep.itemGuid),
      feedRef: ep.feedGuid ? showId(ep.feedGuid) : undefined,
      medium: ep.medium,
    }));
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
    lastSynced: (list) =>
      list === 'items'
        ? storage.favSyncedItems.get(identity.npub)
        : storage.favSynced.get(identity.npub),
    // Both callbacks also move `favoritesSync`, so the whole feature reports
    // its relay health from one place: hydration routes its own success
    // through this same `onSynced` (see favorites-hydrator.ts), and a publish
    // that lands is proof the relays are answering again — it clears a notice
    // an earlier degraded read put up.
    // Per list, both directions. One flag across both would let a good feeds
    // publish clear a notice a failed items read raised — the user gets a
    // confident empty state for their entire track library.
    onSynced: (list, ids) => {
      if (list === 'items') storage.favSyncedItems.set(identity.npub, ids);
      else storage.favSynced.set(identity.npub, ids);
      useApp.getState().setFavoritesSync(list, 'ok');
    },
    onDegraded: (list) => useApp.getState().setFavoritesSync(list, 'degraded'),
  };
}

/**
 * One favorites read-merge-publish cycle at a time.
 *
 * Hydration and a heart-toggle publish are the SAME cycle as far as the relays
 * are concerned: both read the list, merge a delta over what came back, and
 * replace the whole event. Run two concurrently and they merge against the same
 * `latest`, so whichever publishes second silently overwrites the first's
 * changes with a `next` computed before they existed — the multi-writer clobber
 * this feature exists to prevent, committed against ourselves.
 *
 * It became reachable when `<FavoritesSyncNotice>` grew a retry button: that
 * fires a hydrate while a debounced publish is already pending. The hydrator's
 * own npub-keyed guard doesn't cover it, because that guard dedupes *identical*
 * work and these are two different jobs.
 *
 * So: serialized, not deduped — a publish queues behind a hydrate rather than
 * joining it. `chain` swallows failures so one rejected cycle can't wedge every
 * later one, the same shape as the settle chain in lib/v4v/streaming.ts.
 */
let chain: Promise<unknown> = Promise.resolve();

export function serializeFavoritesCycle<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

// Collapses rapid heart-toggles into one cycle, and so one signing prompt. The
// getters in SyncOptions are re-read at fire time, so a burst publishes once
// with the final set.
const scheduleFavoritesPublish = createScheduledPublish('favorites');

/** Debounced read-merge-publish. Signed out, favorites stay local — no-op. */
export function requestFavoritesSync(identity: NostrIdentity | null | undefined) {
  if (!identity) return;
  scheduleFavoritesPublish(() =>
    serializeFavoritesCycle(() => syncFavorites(syncOptionsFor(identity))),
  );
}

/** Immediate read-merge-publish, for callers that must await the result. */
export function syncFavoritesNow(identity: NostrIdentity) {
  return serializeFavoritesCycle(() => syncFavorites(syncOptionsFor(identity)));
}
