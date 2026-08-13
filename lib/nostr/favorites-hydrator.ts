'use client';

// Reconcile this device's local favorites with the SHARED cross-app kind:30078
// list on Nostr. Extracted from `components/nostr-auth.tsx` so the
// circuit-breaker probe-first pattern is reusable and the auth component
// stays focused on UI concerns.
//
// The list is shared with other podcast apps — see the spec at
// github.com/ChadFarrow/PC20-Nostr/specs/pc20-favorites.md — so
// two rules run through everything here:
//
//   1. A degraded read is never treated as data. It means "we couldn't ask",
//      not "the list is empty", and acting on it destroys favorites this
//      device never saw.
//   2. What we can't render, we still carry. Interpretation is lossy on
//      purpose — identifiers from apps we don't know about survive untouched
//      because `mergeSharedFavorites` never looks inside them.
//   3. A degraded read is announced. Rule 1 keeps the data safe and says
//      nothing, which on a device with no cache is a blank list that reads as
//      "your favorites are gone" — see `favoritesSync` in lib/store.ts.

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
import {
  localFavoriteItems,
  requestFavoritesSync,
  serializeFavoritesCycle,
  syncOptionsFor,
} from './favorites-sync';
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

  const legacy = await fetchLegacyFavorites(identity.pubkey, resolvePublishRelays(identity));
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
    // Baseline is `merged ∩ what this DEVICE currently holds` — deliberately
    // NOT `merged ∩ legacy.items`, which is the obvious reading of "our own
    // contribution" and is wrong in a way that undoes the migration it just
    // performed.
    //
    // The baseline is not a record of authorship, it's a promise: every id in
    // it must be one `local` will keep asserting, because the next merge
    // computes `removes = baseline − local`. The store is empty of these shows
    // at this point in the hydrate — `setFavorites` doesn't run until ~35
    // lines below, after the merge — so a baseline naming the legacy ids makes
    // the very next `mergeSharedFavorites` in this same function read all of
    // them as local removals and publish them straight back out.
    //
    // That shipped: `[favorites] migrated 17 entries` logged on every single
    // page load, adding 17 and deleting 17 twice per load, and 0 of the 17 ever
    // reached the shared list. Nothing was lost — the legacy event is never
    // touched, which is exactly the rollback path the spec prescribes — but the
    // migration could never complete.
    //
    // Passing `local` instead leaves the migrated ids out of the baseline, so
    // the merge treats them as foreign and CARRIES them, which is the safe
    // direction. They're adopted into the baseline on a later hydrate, once
    // they've resolved into the store and `local` can honour the promise.
    storage.favSynced.set(identity.npub, baselineFrom(merged, localFavoriteItems()));
    // eslint-disable-next-line no-console
    console.info(
      `[favorites] migrated ${merged.length - shared.items.length} entries from the legacy list`,
    );
    return merged;
  } catch (e) {
    // Migration is best-effort: the next hydration retries it, and until then
    // the legacy list is still intact on relays. `publishSharedFavorites`
    // throws when the event reached no relay, so this catch is also what keeps
    // the baseline above from being written for a migration that didn't land —
    // which would have made the retry a no-op forever.
    // eslint-disable-next-line no-console
    console.warn('[favorites] legacy migration did not land:', (e as Error)?.message ?? e);
    return shared.items;
  }
}

/**
 * Reconcile local favorites with the shared kind:30078 list, then resolve any
 * identifiers this device hasn't seen before via Podcast Index.
 *
 * Two guards, and they do different jobs — the first without the second was
 * the bug:
 *
 *   - **Deduped** here, keyed by npub: a second hydrate for the same account
 *     joins the first rather than starting its own cycle, so a double-tap on
 *     the retry button doesn't publish twice. Keyed by npub so an account
 *     switch is never handed the previous account's in-flight run.
 *   - **Serialized** by `serializeFavoritesCycle`: a heart-toggle publish is
 *     not the same work as a hydrate, so it can't be deduped away — it has to
 *     queue behind. Two cycles overlapping means two merges against the same
 *     `latest`, and the second publish overwrites the first's changes.
 */
let inFlight: { npub: string; promise: Promise<void> } | null = null;

export function hydrateFavorites(identity: NostrIdentity): Promise<void> {
  if (inFlight?.npub === identity.npub) return inFlight.promise;
  const promise = serializeFavoritesCycle(() => runHydrate(identity)).finally(() => {
    if (inFlight?.promise === promise) inFlight = null;
  });
  inFlight = { npub: identity.npub, promise };
  return promise;
}

async function runHydrate(identity: NostrIdentity): Promise<void> {
  const { setFavorites, setFavoriteEpisodes, setFavoritesSync } = useApp.getState();
  const cached = storage.favorites.get(identity.npub);
  const cachedEpisodes = storage.favoriteEpisodes.get(identity.npub);

  setFavoritesSync('loading');

  // The read, and only the read, decides the status. A throw anywhere in here
  // means we never got an answer we could trust, and the caller in nostr-auth
  // swallows it (`.catch(() => {})`) — without this the status would sit on
  // 'loading' forever and the notice would never appear.
  let shared: Awaited<ReturnType<typeof fetchSharedFavorites>>;
  try {
    shared = await fetchSharedFavorites(identity.pubkey, resolvePublishRelays(identity));
  } catch (e) {
    setFavoritesSync('degraded');
    throw e;
  }

  if (!shared.trustworthy) {
    // Nothing answered. Keep whatever is on screen and publish nothing — the
    // next toggle or page load retries. Silently adopting the empty result
    // here is how a relay wobble turns into a wiped favorites list.
    setFavoritesSync('degraded');
    // eslint-disable-next-line no-console
    console.warn('[favorites] relay read was degraded — keeping local favorites as-is');
    return;
  }

  // Set here rather than at the end of the function: everything below is
  // Podcast Index resolution, which fails for its own unrelated reasons and
  // must not be reported as "couldn't reach the relays".
  setFavoritesSync('ok');

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
  //
  // EVERY id in `target` gets a row here, resolved or not. That is not a
  // rendering preference, it is the fix for a real deletion: `setFavorites`
  // below REPLACES the store and writes through to localStorage, and
  // `localFavoriteItems()` publishes from that same store. Building these maps
  // from PI-resolved entries only meant an outage pruned the store while
  // `baselineFrom(target, local)` still recorded the un-pruned set — so the
  // next page load computed `removes = baseline − local` over everything that
  // failed to resolve and published the deletion to a list other apps read.
  // One outage plus one reload. A placeholder row costs a line; that cost a
  // user's library.
  const nextShows: Record<string, FavoritePodcast> = {};
  const unresolvedShows: string[] = [];
  for (const guid of guids) {
    const hit = cached[guid];
    // addedAt 0 = "not known yet", so the first real resolve stamps its own
    // rather than inheriting a placeholder's — see the merges below.
    nextShows[guid] = hit ?? { id: 0, podcastGuid: guid, addedAt: 0 };
    if (!hit || !hit.artwork) unresolvedShows.push(guid);
  }

  const nextEpisodes: Record<string, FavoriteEpisode> = {};
  const unresolvedEpisodes: Array<{ itemGuid: string; feedGuid?: string; feedUrl?: string }> = [];
  for (const ep of episodes) {
    const hit = cachedEpisodes[ep.itemGuid];
    nextEpisodes[ep.itemGuid] = hit ?? {
      itemGuid: ep.itemGuid,
      feedGuid: ep.feedGuid,
      feedUrl: ep.feedUrl,
      addedAt: 0,
    };
    // PI's /episodes/byguid wants a parent guid, so an entry without one can't
    // be resolved. It still gets a row, still rides through every republish,
    // and renders unresolved — it is the user's favorite either way.
    if (!hit && ep.feedGuid) unresolvedEpisodes.push(ep);
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
      // the favorite to the top of the list on every backfill. `prev` is now
      // always present (placeholders included), so test the timestamp rather
      // than the row — a placeholder's 0 must not be inherited as a real one.
      const prev = merged[fav.podcastGuid];
      merged[fav.podcastGuid] = prev?.addedAt ? { ...fav, addedAt: prev.addedAt } : fav;
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
      merged[fav.itemGuid] = prev?.addedAt ? { ...fav, addedAt: prev.addedAt } : fav;
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
    // Queued like every other cycle: this reads the list and replaces it, so
    // running it while a debounced toggle publish is pending would have the two
    // merge against the same `latest`.
    (window as any).bmbCleanFavorites = async () => serializeFavoritesCycle(async () => {
      const shared = await fetchSharedFavorites(identity.pubkey, resolvePublishRelays(identity));
      if (!shared.trustworthy) return 'could not read the current list — try again';
      const doomed = new Set(malformed.map((g) => showId(g)));
      const kept = shared.items.filter((i) => !doomed.has(i.id));
      try {
        await publishSharedFavorites(kept, shared.otherTags, resolvePublishRelays(identity), identity.pubkey);
      } catch (e) {
        // Reporting "removed N" for an event no relay took would be a lie the
        // user acts on — they'd stop running it. The baseline below stays
        // unwritten either way, so a retry is still a real retry.
        return `nothing removed — ${(e as Error)?.message ?? e}`;
      }
      storage.favSynced.set(identity.npub, baselineFrom(kept, localFavoriteItems()));
      return `removed ${shared.items.length - kept.length} malformed entries`;
    });
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[favorites] ${malformed.length} entries in your shared list aren't valid podcast guids:`,
    malformed,
    '\nThey are preserved on relays. To remove them permanently, run:',
    '  bmbCleanFavorites()',
  );
}
