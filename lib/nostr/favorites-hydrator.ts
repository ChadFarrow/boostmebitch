'use client';

// Reconcile this device's local favorites with the SHARED cross-app kind:30078
// list on Nostr. Extracted from `components/nostr-auth.tsx` so the
// circuit-breaker probe-first pattern is reusable and the auth component
// stays focused on UI concerns.
//
// The list is shared with other podcast apps (see docs/pc20-favorites.md), so
// two rules run through everything here:
//
//   1. A degraded read is never treated as data. It means "we couldn't ask",
//      not "the list is empty", and acting on it destroys favorites this
//      device never saw.
//   2. What we can't render, we still carry. Interpretation is lossy on
//      purpose — identifiers from apps we don't know about survive untouched
//      because `mergeSharedFavorites` never looks inside them.

import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { piMaybeUp, resolveEpisodeByGuid, resolvePodcastByGuid } from '@/lib/podcast-meta';
import type { Episode, FavoriteEpisode, FavoritePodcast, Podcast } from '@/lib/types';
import {
  baselineFrom,
  fetchLegacyFavorites,
  fetchSharedFavorites,
  interpretItems,
  interpretShows,
  mergeSharedFavorites,
  publishSharedFavorites,
  showId,
  type SharedFavoriteItem,
} from './favorites';
import { localFavoriteItems, requestFavoritesSync, syncOptionsFor } from './favorites-sync';
import { sharedFavoritesEnabledFor } from './favorites-gate';
import { resolvePublishRelays } from './relays';
import type { NostrIdentity } from './auth';

function favoriteFromPodcast(p: Podcast): FavoritePodcast | null {
  if (!p?.podcastGuid) return null;
  return {
    id: p.id,
    podcastGuid: p.podcastGuid,
    title: p.title,
    author: p.author,
    image: p.image,
    artwork: p.artwork,
    url: p.url,
    addedAt: Date.now(),
  };
}

async function resolveGuidToFavorite(guid: string): Promise<FavoritePodcast | null> {
  const podcast = await resolvePodcastByGuid(guid);
  return podcast ? favoriteFromPodcast(podcast) : null;
}

function favoriteFromEpisode(
  ep: Episode,
  feedGuid: string,
  feedUrl?: string,
): FavoriteEpisode | null {
  if (!ep?.guid) return null;
  return {
    itemGuid: ep.guid,
    feedGuid: ep.podcastGuid || feedGuid,
    feedId: ep.feedId,
    feedUrl,
    title: ep.title,
    podcastTitle: ep.feedTitle,
    image: ep.image || ep.feedImage,
    enclosureUrl: ep.enclosureUrl,
    datePublished: ep.datePublished,
    addedAt: Date.now(),
  };
}

/**
 * Resolve a list of unknown identifiers through PI, probe-first-then-batch.
 *
 * The probe is sequential and deliberate: if PI is dead (or the breaker already
 * tripped earlier this session) the remaining N−1 are skipped rather than
 * opening ~99 parallel sockets that are all going to fail. A returning user
 * with a 100-entry list would otherwise hammer a broken endpoint on every
 * reload, which StrictMode and Fast Refresh amplify into thousands.
 */
async function resolveBatch<T, R>(
  pending: T[],
  resolve: (item: T) => Promise<R | null>,
): Promise<(R | null)[]> {
  if (pending.length === 0) return [];
  const first = await resolve(pending[0]);
  const remaining = piMaybeUp() ? pending.slice(1) : [];
  const rest = await Promise.all(remaining.map(resolve));
  return [first, ...rest];
}

/**
 * One-time move from this app's private list to the shared address.
 *
 * Only runs when BOTH reads are trustworthy: a degraded read of the legacy list
 * would silently drop a user's entire pre-sync history, and a degraded read of
 * the shared list would republish over another app's entries. The old event is
 * left in place — it costs nothing and is the rollback path.
 */
async function migrateLegacyList(
  identity: NostrIdentity,
  shared: Awaited<ReturnType<typeof fetchSharedFavorites>>,
): Promise<SharedFavoriteItem[]> {
  // Only accounts on the shared list have anything to migrate TO. For everyone
  // else the legacy address is still where their favorites live and are
  // published, so `shared` here already IS the legacy list — merging it into
  // itself would be a wasted relay round trip on every hydrate, and a publish
  // whenever the two reads raced.
  if (!sharedFavoritesEnabledFor(identity.pubkey)) return shared.items;

  const legacy = await fetchLegacyFavorites(identity.pubkey);
  if (!legacy.trustworthy || !legacy.exists || legacy.items.length === 0) {
    return shared.items;
  }
  const merged = mergeSharedFavorites({
    latest: shared.items,
    // No baseline: a migration only ever adds. Passing the legacy ids here
    // would read them as "removals" for anything the shared list already had.
    lastSynced: [],
    local: legacy.items,
  });
  if (merged.length === shared.items.length) return shared.items; // nothing new
  try {
    await publishSharedFavorites(merged, shared.otherTags, resolvePublishRelays(identity), identity.pubkey);
    // Baseline is our own contribution only — the legacy entries we just moved
    // across. Recording the whole merged list would put another app's entries
    // in it, and the next publish would read them as our removals.
    storage.favSynced.set(identity.npub, baselineFrom(merged, legacy.items));
    // eslint-disable-next-line no-console
    console.info(
      `[favorites] migrated ${merged.length - shared.items.length} entries from the legacy list`,
    );
    return merged;
  } catch {
    // Migration is best-effort: the next hydration retries it, and until then
    // the legacy list is still intact on relays.
    return shared.items;
  }
}

/**
 * Reconcile local favorites with the shared kind:30078 list, then resolve any
 * identifiers this device hasn't seen before via Podcast Index.
 */
export async function hydrateFavorites(identity: NostrIdentity): Promise<void> {
  const { setFavorites, setFavoriteEpisodes } = useApp.getState();
  const cached = storage.favorites.get(identity.npub);
  const cachedEpisodes = storage.favoriteEpisodes.get(identity.npub);

  const shared = await fetchSharedFavorites(identity.pubkey);

  if (!shared.trustworthy) {
    // Nothing answered. Keep whatever is on screen and publish nothing — the
    // next toggle or page load retries. Silently adopting the empty result
    // here is how a relay wobble turns into a wiped favorites list.
    // eslint-disable-next-line no-console
    console.warn('[favorites] relay read was degraded — keeping local favorites as-is');
    return;
  }

  // Runs on every hydrate, not just the first: it is a no-op once the legacy
  // list is empty or fully absorbed, and a user who signs in on a second
  // device months later still has their pre-sync history waiting there.
  const items = await migrateLegacyList(identity, shared);

  // First sign-in on a device that already has local favorites: adopt them and
  // push them up. This is why nostr-auth must clear favorites on an account
  // switch — otherwise account A's list gets published under account B's key.
  const local = localFavoriteItems();
  const lastSynced = storage.favSynced.get(identity.npub);
  const target = mergeSharedFavorites({ latest: items, lastSynced, local });

  const { guids, malformed } = interpretShows(target);
  const episodes = interpretItems(target);

  if (malformed.length > 0) installCleanupHook(identity, malformed);

  // Paint from cache immediately, queue the rest. Cached entries missing
  // `artwork` are re-resolved too, so caches written before that field existed
  // get backfilled — otherwise the row keeps falling back to the placeholder
  // whenever `image` 404s.
  const nextShows: Record<string, FavoritePodcast> = {};
  const unresolvedShows: string[] = [];
  for (const guid of guids) {
    if (cached[guid]) {
      nextShows[guid] = cached[guid];
      if (!cached[guid].artwork) unresolvedShows.push(guid);
    } else {
      unresolvedShows.push(guid);
    }
  }

  const nextEpisodes: Record<string, FavoriteEpisode> = {};
  const unresolvedEpisodes: Array<{ itemGuid: string; feedGuid?: string; feedUrl?: string }> = [];
  for (const ep of episodes) {
    if (cachedEpisodes[ep.itemGuid]) nextEpisodes[ep.itemGuid] = cachedEpisodes[ep.itemGuid];
    else if (ep.feedGuid) unresolvedEpisodes.push(ep);
    // An item with no parent feed is unresolvable through PI. It stays on the
    // wire (the merge never drops it) but this device can't render it.
  }

  setFavorites(nextShows);
  setFavoriteEpisodes(nextEpisodes);

  if (unresolvedShows.length > 0) {
    const resolved = await resolveBatch(unresolvedShows, resolveGuidToFavorite);
    const merged = { ...useApp.getState().favorites };
    for (const fav of resolved) {
      if (!fav) continue;
      // Preserve the original addedAt when refreshing an existing entry;
      // resolveGuidToFavorite stamps Date.now(), which would otherwise bubble
      // the favorite to the top of the list on every backfill.
      const prev = merged[fav.podcastGuid];
      merged[fav.podcastGuid] = prev ? { ...fav, addedAt: prev.addedAt } : fav;
    }
    setFavorites(merged);
  }

  if (unresolvedEpisodes.length > 0) {
    const resolved = await resolveBatch(unresolvedEpisodes, async (ep) => {
      const episode = await resolveEpisodeByGuid(ep.feedGuid!, ep.itemGuid);
      return episode ? favoriteFromEpisode(episode, ep.feedGuid!, ep.feedUrl) : null;
    });
    const merged = { ...useApp.getState().favoriteEpisodes };
    for (const fav of resolved) {
      if (!fav) continue;
      const prev = merged[fav.itemGuid];
      merged[fav.itemGuid] = prev ? { ...fav, addedAt: prev.addedAt } : fav;
    }
    setFavoriteEpisodes(merged);
  }

  // The merged set is what everyone should now agree on. Publish only when it
  // actually differs from what the relay holds — a no-op republish on every
  // page load would bump created_at for nothing and race other devices.
  const relayIds = items.map((i) => i.id).join('\n');
  const targetIds = target.map((i) => i.id).join('\n');
  if (relayIds !== targetIds) {
    requestFavoritesSync(identity);
  } else {
    // Still record the baseline: without it the first unfavorite on this
    // device has nothing to diff against and silently fails to propagate.
    // Scoped to what this app contributed — see `baselineFrom`.
    syncOptionsFor(identity).onSynced(baselineFrom(target, local));
  }
}

/**
 * Expose a one-shot purge for malformed `podcast:guid:` entries — feed IDs and
 * live-episode strings written by old versions of this app, which 404 against
 * PI. It stays an explicit user action rather than an automatic cleanup:
 * the merge preserves every identifier by design, and "this app can't read it"
 * is not the same claim as "this is junk".
 */
function installCleanupHook(identity: NostrIdentity, malformed: string[]) {
  if (typeof window !== 'undefined') {
    (window as any).bmbCleanFavorites = async () => {
      const shared = await fetchSharedFavorites(identity.pubkey);
      if (!shared.trustworthy) return 'could not read the current list — try again';
      const doomed = new Set(malformed.map((g) => showId(g)));
      const kept = shared.items.filter((i) => !doomed.has(i.id));
      await publishSharedFavorites(kept, shared.otherTags, resolvePublishRelays(identity), identity.pubkey);
      storage.favSynced.set(identity.npub, baselineFrom(kept, localFavoriteItems()));
      return `removed ${shared.items.length - kept.length} malformed entries`;
    };
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[favorites] ${malformed.length} entries in your shared list aren't valid podcast guids:`,
    malformed,
    '\nThey are preserved on relays. To remove them permanently, run:',
    '  bmbCleanFavorites()',
  );
}
