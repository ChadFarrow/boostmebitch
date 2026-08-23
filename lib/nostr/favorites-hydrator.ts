'use client';

// Reconcile this device's local favorites with the SHARED cross-app kind:10333
// list on Nostr. Extracted from `components/nostr-auth.tsx` so the
// circuit-breaker probe-first pattern is reusable and the auth component stays
// focused on UI concerns.
//
// The list is shared with other podcast apps — see the spec at
// github.com/ChadFarrow/PC20-Nostr/blob/main/pc20-favorites.md — and it is ONE
// replaceable event, so four rules run through everything here:
//
//   1. A degraded read is never treated as data. It means "we couldn't ask",
//      not "the list is empty", and acting on it destroys favorites this device
//      never saw. Under wholesale replacement that is the most expensive
//      mistake the format allows: one bad read, republished, is the whole list.
//   2. What we can't render, we still carry. Interpretation is lossy on
//      purpose — identifiers and tags from apps we don't know about survive
//      untouched because the merge never looks inside them.
//   3. A degraded read is announced. Rule 1 keeps the data safe and says
//      nothing, which on a device with no cache is a blank list that reads as
//      "your favorites are gone" — see `favoritesSync` in lib/store.ts.
//   4. The merge runs EXACTLY ONCE per cycle. The previous version merged here
//      and again inside the publish planner, and the two drifted; the planner
//      now takes the already-merged list, so the store and the wire cannot
//      disagree about what this device is asserting.

import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { piMaybeUp, resolveEpisodeByGuid, resolvePodcastByGuid } from '@/lib/podcast-meta';
import type { Episode, FavoriteEpisode, FavoritePodcast, Podcast } from '@/lib/types';
import {
  baselineFrom,
  fetchFavoritesList,
  groupLocalFavorites,
  looksLikeFeedGuid,
  mergeFavoritesList,
  partitionList,
  planFavoritesPublish,
  publishFavoritesTags,
  tagsFromList,
} from './favorites';
import {
  localFavoriteEntries,
  localFavoriteList,
  requestFavoritesSync,
  serializeFavoritesCycle,
  trustedBaseline,
  syncOptionsFor,
} from './favorites-sync';
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
    // What the FEED declared, as Podcast Index reports it — never a default and
    // never this app's own category for the show.
    medium: p.medium,
    addedAt: Date.now(),
  };
}

async function resolveGuidToFavorite(guid: string): Promise<FavoritePodcast | null> {
  const podcast = await resolvePodcastByGuid(guid);
  return podcast ? favoriteFromPodcast(podcast) : null;
}

function favoriteFromEpisode(ep: Episode, feedGuid: string): FavoriteEpisode | null {
  if (!ep?.guid) return null;
  return {
    itemGuid: ep.guid,
    feedGuid: ep.podcastGuid || feedGuid,
    feedId: ep.feedId,
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
// Concurrency ceiling for the batch below. NOT about our own server — it is
// about the BROWSER's connection pool.
//
// A browser allows ~6 concurrent connections per host. `Promise.all` over a
// 100-entry favorites list issues 100 fetches at once, so the other 94 sit in
// the pool queue — and so does anything the USER asks for next, because it
// joins the same queue behind them. Measured on Regular 3G: clicking a show
// sat on "loading episodes…" while ~100 by-guid calls drained, with the server
// answering the feed request in 241ms once it finally arrived. On a fast link
// the queue clears instantly and the starvation is invisible, which is why this
// only ever shows up on a slow connection — i.e. for the users it hurts most.
//
// Six leaves headroom in the pool for a navigation to overtake the burst.
// Hydration is background work; the thing the user just clicked is not.
const HYDRATE_CONCURRENCY = 6;

/** Map with a bounded number of in-flight promises, preserving input order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function resolveBatch<T, R>(
  pending: T[],
  resolve: (item: T) => Promise<R | null>,
): Promise<(R | null)[]> {
  if (pending.length === 0) return [];
  const first = await resolve(pending[0]);
  const remaining = piMaybeUp() ? pending.slice(1) : [];
  const rest = await mapLimit(remaining, HYDRATE_CONCURRENCY, resolve);
  return [first, ...rest];
}

let inFlight: { npub: string; promise: Promise<void> } | null = null;

/**
 * Hydrate favorites for `identity`, deduped per npub and serialized against any
 * other favorites cycle.
 */
export function hydrateFavorites(identity: NostrIdentity): Promise<void> {
  if (inFlight?.npub === identity.npub) return inFlight.promise;
  const promise = serializeFavoritesCycle(() => runHydrate(identity))
    .finally(() => { if (inFlight?.npub === identity.npub) inFlight = null; });
  inFlight = { npub: identity.npub, promise };
  return promise;
}

async function runHydrate(identity: NostrIdentity): Promise<void> {
  const { setFavorites, setFavoriteEpisodes, setFavoritesSync } = useApp.getState();
  const cached = storage.favorites.get(identity.npub);
  const cachedEpisodes = storage.favoriteEpisodes.get(identity.npub);
  const relays = resolvePublishRelays(identity);

  setFavoritesSync('loading');

  // The read, and only the read, decides the status. A throw anywhere in here
  // means we never got an answer we could trust, and the caller in nostr-auth
  // swallows it (`.catch(() => {})`) — without this the status would sit on
  // 'loading' forever and the notice would never appear.
  let read: Awaited<ReturnType<typeof fetchFavoritesList>>;
  try {
    read = await fetchFavoritesList(identity.pubkey, relays);
  } catch (e) {
    setFavoritesSync('degraded');
    throw e;
  }

  if (!read.trustworthy) {
    // Nothing answered. Keep whatever is on screen and publish nothing — the
    // next toggle or page load retries. Silently adopting the empty result here
    // is how a relay wobble turns into a wiped favorites list.
    setFavoritesSync('degraded');
    // eslint-disable-next-line no-console
    console.warn('[favorites] relay read was degraded — keeping local favorites as-is');
    return;
  }

  // First sign-in on a device that already has local favorites: adopt them and
  // push them up. This is why nostr-auth must clear favorites on an account
  // switch — otherwise account A's list gets published under account B's key.
  const local = groupLocalFavorites(localFavoriteEntries());
  // Same guard the publish path uses. Read directly and this function becomes
  // the one place that still believes a baseline no other caller does.
  const baseline = trustedBaseline(identity.npub);
  const merged = mergeFavoritesList({ read: read.list, local, baseline });

  // PLAN BEFORE PAINTING, because `setFavorites` writes THROUGH to localStorage
  // and this device's cache is an INPUT to the next hydrate, not a copy of the
  // output. `cached[feed.feedGuid]` below is the only thing that tells a real
  // album favorite from a group opened purely to place a track — the wire cannot
  // restate that — so painting an empty merge doesn't blank a screen, it
  // destroys the one record that keeps those rows recoverable, and the next load
  // reads every one of them as placement-only. Forever.
  //
  // `planFavoritesPublish` already knows the shape that must never be believed;
  // it was simply consulted too late and too narrowly. Two things were wrong:
  // it ran AFTER the store had been replaced, and only `plan.publish` was read,
  // so `wholesale-delete` fell through to the `else` and called `onSynced` with
  // `baselineFrom(local)` — an EMPTY baseline recorded as agreement, plus an
  // 'ok' status, for a list the planner had just refused to write. That is
  // exactly what CLAUDE.md forbids: the next cycle then diffs against "we
  // published nothing" and quietly agrees with the emptiness.
  const plan = planFavoritesPublish({
    merged,
    readTags: read.tags,
    exists: read.exists,
    trustworthy: true, // the untrustworthy case returned above
    local,
  });

  // "This device holds nothing" is not the same claim as "the user cleared their
  // favorites" — one is an unhydrated store, and the store is rebuilt from
  // scratch on every load while the baseline is read from disk. The planner
  // tests that against the RELAY's tags; the second half here tests it against
  // this device's CACHE, which catches the same mistake when the relay copy is
  // also missing (a narrowed read, another app's delete). Both refuse the same
  // way a degraded read does: keep what is on screen, publish nothing, and
  // record NO baseline — `onSynced` here would make the next cycle agree.
  const cacheHasEntries =
    Object.keys(cached).length > 0 || Object.keys(cachedEpisodes).length > 0;
  if (plan.reason === 'wholesale-delete' || (merged.nodes.length === 0 && cacheHasEntries)) {
    setFavoritesSync('degraded');
    // eslint-disable-next-line no-console
    console.warn(
      '[favorites] REFUSING to adopt an empty merge — this device holds favorites '
      + `(cache: ${Object.keys(cached).length} feeds, ${Object.keys(cachedEpisodes).length} items; `
      + `relay: ${read.tags.filter((t) => t[0] === 'i').length} entries) and the merge came out empty. `
      + 'Keeping local state, publishing nothing, recording no baseline.',
    );
    return;
  }

  // Set here rather than at the end of the function: everything below is
  // Podcast Index resolution, which fails for its own unrelated reasons and must
  // not be reported as "couldn't reach the relays". Set here rather than ABOVE
  // the merge, too — the refusal branch has to be able to report 'degraded'.
  setFavoritesSync('ok');

  const part = partitionList(merged);

  if (part.malformed.length > 0) installCleanupHook(identity, part.malformed);

  // Paint from cache immediately, queue the rest. Cached entries missing
  // `artwork` are re-resolved too, so caches written before that field existed
  // get backfilled — otherwise the row keeps falling back to the placeholder
  // whenever `image` 404s.
  //
  // EVERY entry on the merged list gets a row here, resolved or not. That is not
  // a rendering preference, it is the fix for a real deletion: `setFavorites`
  // below REPLACES the store and writes through to localStorage, and
  // `localFavoriteEntries()` publishes from that same store. Building these maps
  // from PI-resolved entries only meant an outage pruned the store while the
  // baseline still named the un-pruned set — so the next page load read every
  // unresolved entry as a local removal and published the deletion to a list
  // other apps read. One outage plus one reload. A placeholder row costs a line;
  // that cost a user's library.
  const nextShows: Record<string, FavoritePodcast> = {};
  const unresolvedShows: string[] = [];
  for (const feed of part.feeds) {
    // A group is opened for every parent of a favorited item, so a group WITH
    // items may exist only to name that parent — reading it as a favorite
    // manufactures albums the user never chose (159 of 197 groups on the list
    // this was written against). Only an itemless group is unambiguous.
    //
    // One exception: this device's own cache. The user favorited it HERE, and
    // the wire's inability to restate that is not evidence against it. On a
    // device without that cache the group reads as placement-only, which is the
    // safe reading — it self-corrects as soon as its last item goes, whereas
    // inventing a favorite never corrects itself.
    const hit = cached[feed.feedGuid];
    if (!feed.itemless && !hit) continue;
    // addedAt 0 = "not known yet", so the first real resolve stamps its own
    // rather than inheriting a placeholder's. A resolved medium always wins over
    // the wire hint; the hint only fills a gap.
    nextShows[feed.feedGuid] = hit
      ? (hit.medium ? hit : { ...hit, medium: feed.medium })
      : { id: 0, podcastGuid: feed.feedGuid, medium: feed.medium, addedAt: 0 };
    if (!hit || !hit.artwork) unresolvedShows.push(feed.feedGuid);
  }

  const nextEpisodes: Record<string, FavoriteEpisode> = {};
  const unresolvedEpisodes: Array<{ itemGuid: string; feedGuid?: string }> = [];
  for (const item of part.items) {
    const hit = cachedEpisodes[item.itemGuid];
    // An item's medium is its PARENT FEED's — Podcasting 2.0 has no per-item
    // one. If that feed is also favorited under its own podcast:guid, its entry
    // wins: never derive a feed's medium from one of its items.
    const hint = (item.feedGuid ? nextShows[item.feedGuid]?.medium : undefined) ?? item.medium;
    nextEpisodes[item.itemGuid] = hit
      ? (hit.medium ? hit : { ...hit, medium: hint })
      : { itemGuid: item.itemGuid, feedGuid: item.feedGuid, medium: hint, addedAt: 0 };
    // PI's /episodes/byguid wants a parent guid, so an entry without one can't
    // be resolved. Nor can one whose parent ref isn't guid-shaped — that gate
    // decides only whether to spend a request, never whether the favorite is
    // kept. Either way it still gets a row, still rides through every republish,
    // and renders unresolved: it is the user's favorite regardless.
    if (!hit && item.feedGuid && looksLikeFeedGuid(item.feedGuid)) {
      unresolvedEpisodes.push({ itemGuid: item.itemGuid, feedGuid: item.feedGuid });
    }
  }

  setFavorites(nextShows);
  setFavoriteEpisodes(nextEpisodes);

  if (unresolvedShows.length > 0) {
    const resolved = await resolveBatch(unresolvedShows, resolveGuidToFavorite);
    const mergedShows = { ...useApp.getState().favorites };
    for (const fav of resolved) {
      if (!fav) continue;
      // Preserve the original addedAt when refreshing an existing entry;
      // resolveGuidToFavorite stamps Date.now(), which would otherwise bubble
      // the favorite to the top of the list on every backfill. `prev` is now
      // always present (placeholders included), so test the timestamp rather
      // than the row — a placeholder's 0 must not be inherited as a real one.
      const prev = mergedShows[fav.podcastGuid];
      // A resolved medium wins, but PI not reporting one must not blank the hint
      // another app put on the wire — that hint is the only answer that exists
      // for a feed PI has delisted.
      const withMedium = fav.medium ? fav : { ...fav, medium: prev?.medium };
      mergedShows[fav.podcastGuid] = prev?.addedAt
        ? { ...withMedium, addedAt: prev.addedAt }
        : withMedium;
    }
    setFavorites(mergedShows);
  }

  if (unresolvedEpisodes.length > 0) {
    const resolved = await resolveBatch(unresolvedEpisodes, async (ep) => {
      const episode = await resolveEpisodeByGuid(ep.feedGuid!, ep.itemGuid);
      return episode ? favoriteFromEpisode(episode, ep.feedGuid!) : null;
    });
    const mergedEpisodes = { ...useApp.getState().favoriteEpisodes };
    for (const fav of resolved) {
      if (!fav) continue;
      const prev = mergedEpisodes[fav.itemGuid];
      // /episodes/byguid returns an Episode, which has no medium — so the only
      // sources are the parent feed's entry and the wire hint, both already in
      // `prev`. Deliberately NOT a per-parent /podcasts/byguid fan-out: a
      // request per entry whose sole purpose is a hint is exactly the cost the
      // hint exists to avoid.
      const withMedium = fav.medium ? fav : { ...fav, medium: prev?.medium };
      mergedEpisodes[fav.itemGuid] = prev?.addedAt
        ? { ...withMedium, addedAt: prev.addedAt }
        : withMedium;
    }
    setFavoriteEpisodes(mergedEpisodes);
  }

  // Publish only when the bytes actually differ from what the relay holds. A
  // no-op republish on every page load would bump created_at for nothing, race
  // other devices, and put a signing prompt on screen for a load that changed
  // nothing. The plan is the one computed above, before the store was touched.
  if (plan.publish) {
    requestFavoritesSync(identity);
  } else {
    // Still record the baseline: without it the first unfavorite on this device
    // has nothing to diff against and silently fails to propagate.
    syncOptionsFor(identity).onSynced(plan.baseline);
  }
}

/**
 * Expose a one-shot purge for malformed `podcast:guid:` entries — feed IDs and
 * live-episode strings written by old versions of this app, which 404 against
 * PI. It stays an explicit user action rather than an automatic cleanup: the
 * merge preserves every identifier by design, and "this app can't read it" is
 * not the same claim as "this is junk".
 */
function installCleanupHook(identity: NostrIdentity, malformed: string[]) {
  if (typeof window !== 'undefined') {
    // Queued like every other cycle: this reads the list and replaces it, so
    // running it while a debounced toggle publish is pending would have the two
    // merge against the same read.
    (window as any).bmbCleanFavorites = async () => serializeFavoritesCycle(async () => {
      const relays = resolvePublishRelays(identity);
      const read = await fetchFavoritesList(identity.pubkey, relays);
      if (!read.trustworthy) return 'could not read the current list — try again';
      const doomed = new Set(malformed);
      const kept = {
        ...read.list,
        nodes: read.list.nodes.filter(
          (n) => !(n.t === 'loose' && !!n.loose.tag[1] && doomed.has(n.loose.tag[1])),
        ),
      };
      const removed = read.list.nodes.length - kept.nodes.length;
      if (removed === 0) return 'nothing to remove';
      try {
        await publishFavoritesTags(tagsFromList(kept), relays);
      } catch (e) {
        // Reporting "removed N" for an event no relay took would be a lie the
        // user acts on — they'd stop running it. The baseline below stays
        // unwritten either way, so a retry is still a real retry.
        return `nothing removed — ${(e as Error)?.message ?? e}`;
      }
      storage.favBaseline.set(identity.npub, baselineFrom(localFavoriteList()));
      return `removed ${removed} malformed entries`;
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
