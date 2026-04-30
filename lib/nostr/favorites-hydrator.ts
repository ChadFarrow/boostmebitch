'use client';

// Reconcile the user's local favorites cache with their NIP-51 kind:30003
// event on Nostr. Extracted from `components/nostr-auth.tsx` so the
// circuit-breaker probe-first pattern is reusable and the auth component
// stays focused on UI concerns.

import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { piMaybeUp, resolvePodcastByGuid } from '@/lib/podcast-meta';
import type { FavoritePodcast, Podcast } from '@/lib/types';
import { fetchFavoriteGuids } from './favorites';
import { resolvePublishRelays } from './relays';
import { schedulePublishFavorites } from './favorites';
import type { NostrIdentity } from './auth';

function favoriteFromPodcast(p: Podcast): FavoritePodcast | null {
  if (!p?.podcastGuid) return null;
  return {
    id: p.id,
    podcastGuid: p.podcastGuid,
    title: p.title,
    author: p.author,
    image: p.image,
    url: p.url,
    addedAt: Date.now(),
  };
}

async function resolveGuidToFavorite(guid: string): Promise<FavoritePodcast | null> {
  const podcast = await resolvePodcastByGuid(guid);
  return podcast ? favoriteFromPodcast(podcast) : null;
}

/**
 * Reconcile the user's local favorites cache with their NIP-51 kind:30003
 * event. Last-write-wins on event.created_at vs the newest cache.addedAt.
 * Resolves unknown guids via /api/by-guid in the background.
 */
export async function hydrateFavorites(identity: NostrIdentity): Promise<void> {
  const setFavorites = useApp.getState().setFavorites;
  const cached = storage.favorites.get(identity.npub);
  const cachedGuids = Object.keys(cached);
  const favEvent = await fetchFavoriteGuids(identity.pubkey);

  if (!favEvent) {
    // No Nostr event yet; if we have local favorites, push them up.
    const local = useApp.getState().favorites;
    if (Object.keys(local).length > 0) {
      setFavorites(local);
      schedulePublishFavorites(
        () => Object.keys(useApp.getState().favorites),
        resolvePublishRelays(identity),
      );
    }
    return;
  }

  if (favEvent.droppedGuids.length > 0) {
    // Old buggy versions of this app (or another client reusing the d-tag)
    // wrote non-UUID values into the favorites event. They'd 404 against
    // PI, so we silently filter them. Log once so the user knows, and
    // expose a one-shot cleanup hook for permanent removal.
    if (typeof window !== 'undefined') {
      (window as any).bmbCleanFavorites = () => {
        const valid = Object.keys(useApp.getState().favorites);
        schedulePublishFavorites(() => valid, resolvePublishRelays(identity));
        return `republishing kind:30003 with ${valid.length} valid guids (debounced ~1.5s)`;
      };
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[favorites] dropped ${favEvent.droppedGuids.length} non-UUID entries from your kind:30003 event:`,
      favEvent.droppedGuids,
      '\nTo permanently remove them from relays, run:',
      '  bmbCleanFavorites()',
    );
  }

  // localStorage doesn't carry an event timestamp; the most recent `addedAt`
  // in the cache is a reasonable proxy.
  const localNewest = cachedGuids.reduce(
    (max, g) => Math.max(max, cached[g].addedAt ?? 0),
    0,
  );
  const nostrNewer = favEvent.updatedAt * 1000 >= localNewest;
  const targetGuids = nostrNewer ? favEvent.guids : cachedGuids;

  // Fill from cache first (cheap), then resolve unknown guids via PI.
  const next: Record<string, FavoritePodcast> = {};
  const unresolved: string[] = [];
  for (const guid of targetGuids) {
    if (cached[guid]) next[guid] = cached[guid];
    else unresolved.push(guid);
  }
  setFavorites(next);

  if (unresolved.length > 0) {
    // Probe sequentially with the first guid. If PI is dead (or already
    // tripped earlier this session), the breaker fires and we skip the
    // rest of the batch instead of opening 99 sockets in parallel that
    // are all going to 500.
    const firstFav = await resolveGuidToFavorite(unresolved[0]);
    const remaining = piMaybeUp() ? unresolved.slice(1) : [];
    const restFavs = await Promise.all(remaining.map(resolveGuidToFavorite));
    const merged = { ...useApp.getState().favorites };
    for (const fav of [firstFav, ...restFavs]) {
      if (fav) merged[fav.podcastGuid] = fav;
    }
    setFavorites(merged);
  }

  if (!nostrNewer && cachedGuids.length > 0) {
    schedulePublishFavorites(
      () => Object.keys(useApp.getState().favorites),
      resolvePublishRelays(identity),
    );
  }
}
