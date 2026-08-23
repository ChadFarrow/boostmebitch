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
  EMPTY_LOCAL,
  EMPTY_PARSED,
  baselineForHalves,
  baselineHalf,
  fetchFavoritesList,
  groupLocalFavorites,
  looksLikeFeedGuid,
  mergeFavoritesList,
  partitionList,
  planFavoritesPublish,
  publishFavoritesTags,
  tagsFromList,
  type ParsedList,
  type PartitionedList,
} from './favorites';
import {
  favoritesMode,
  localFavoriteEntries,
  localFavoriteList,
  privateFavoritesEnabled,
  requestFavoritesSync,
  seedFavoritesMode,
  serializeFavoritesCycle,
  trustedBaseline,
  syncOptionsFor,
  unattendedDecryptOk,
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

  // 'off' is this device only: no read, no publish, and nothing on a relay is
  // touched. Returning BEFORE the query is the point — a read here would be
  // harmless but the status it sets would not, and an 'ok' on a list we have
  // stopped syncing invites the next surface to believe it.
  //
  // What is already on the relay stays there. We do not delete on someone's
  // behalf from a settings change; `withdrawThisDevice` is the explicit route,
  // and the dialog that offers it says what happens either way.
  //
  // 'off' rather than 'idle': both mean "no read happened", but a surface
  // waiting on 'idle' is waiting for something that will never start, and
  // <FavoritesPage> renders that as "loading your favorites…" with nothing
  // behind it.
  if (favoritesMode(identity.npub) === 'off') {
    setFavoritesSync('off');
    return;
  }

  setFavoritesSync('loading');

  // The read, and only the read, decides the status. A throw anywhere in here
  // means we never got an answer we could trust, and the caller in nostr-auth
  // swallows it (`.catch(() => {})`) — without this the status would sit on
  // 'loading' forever and the notice would never appear.
  let read: Awaited<ReturnType<typeof fetchFavoritesList>>;
  try {
    // DO NOT SPEND A SIGNER PROMPT HERE. This runs on every page load and on
    // every sign-in, and a decrypt approval sheet on a cold start is something
    // nobody asked for — Amber's shows the PLAINTEXT, and on a Pixel 6 it was
    // measured returning the user to the launcher, so the request never
    // resolved and the prompt came straight back. The ciphertext rides through
    // opaquely instead, the local cache still renders, and the retry on
    // <FavoritesSyncNotice> is the user's explicit way in.
    read = await fetchFavoritesList(identity.pubkey, relays, {
      decryptPrivate: privateFavoritesEnabled() && unattendedDecryptOk(),
      purpose: 'unattended',
    });
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

  // An account that already HAS a list is never asked which half it wants — the
  // wire already says. Seeding here, off the one trustworthy read of the cycle,
  // is what keeps the first-favorite prompt aimed at people whose first
  // favorite it really is. Both halves empty leaves it unrecorded on purpose.
  const mode = seedFavoritesMode(identity.npub, read) ?? favoritesMode(identity.npub) ?? 'public';
  const deliberatelyEmpty = storage.favCleared.get(identity.npub);

  // First sign-in on a device that already has local favorites: adopt them and
  // push them up. This is why nostr-auth must clear favorites on an account
  // switch — otherwise account A's list gets published under account B's key.
  //
  // ONE local list, split by the mode: everything this device holds goes into
  // one half, and the other is still read, merged and carried so another app's
  // entries — or our own, mid-switch — survive.
  const all = groupLocalFavorites(localFavoriteEntries());
  const local = mode === 'private' ? EMPTY_LOCAL : all;
  const privateLocal = mode === 'private' ? all : EMPTY_LOCAL;
  // Same guard the publish path uses. Read directly and this function becomes
  // the one place that still believes a baseline no other caller does.
  const baseline = trustedBaseline(identity.npub);
  const merged = mergeFavoritesList({
    read: read.list,
    local,
    baseline: baselineHalf(baseline, 'public'),
  });
  // Null, not an empty merge, when we could not read it: "carry these bytes"
  // and "there is nothing there" are different claims and only one is safe to
  // paint from.
  const privateMerged: ParsedList | null = read.privateUnreadable
    ? null
    : mergeFavoritesList({
      read: read.privateList ?? EMPTY_PARSED,
      local: privateLocal,
      baseline: baselineHalf(baseline, 'private'),
    });

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
    mode,
    privateMerged,
    readPrivateTags: read.privateTags,
    readContent: read.content,
    privateUnreadable: read.privateUnreadable,
    privateLocal,
    // A reload lands here with the removal still unpublished, so the hydrator
    // has to honour the same intent the publish path does — otherwise it
    // re-adopts everything off the relay and the user's delete is undone
    // before the debounce that would have carried it ever fires.
    emptyIsIntentional: deliberatelyEmpty,
    previousBaseline: baseline,
  });

  // "This device holds nothing" is not the same claim as "the user cleared their
  // favorites" — one is an unhydrated store, and the store is rebuilt from
  // scratch on every load while the baseline is read from disk. The planner
  // tests that against the RELAY's tags; the second half here tests it against
  // this device's CACHE, which catches the same mistake when the relay copy is
  // also missing (a narrowed read, another app's delete). Both refuse the same
  // way a degraded read does: keep what is on screen, publish nothing, and
  // record NO baseline — `onSynced` here would make the next cycle agree.
  // A private half we could not open is not a private half that is empty, and
  // painting from the public half alone would show the user a list missing
  // everything they chose to hide. Keep what is on screen and say why. The
  // planner has already refused the publish for the same reason; this is the
  // rendering half of the same decision.
  if (plan.reason === 'private-unreadable') {
    setFavoritesSync('degraded', 'private-unreadable');
    // eslint-disable-next-line no-console
    console.warn(
      '[favorites] this list has an encrypted half we could not read — keeping local '
      + 'favorites as-is and carrying the ciphertext untouched',
    );
    return;
  }

  // BOTH halves count here, for the same reason they do in the planner: a mode
  // switch legitimately empties one of them, so a per-half test would refuse
  // the feature it exists to protect. The pair is fed from ONE local list, so
  // an unhydrated store empties them together while a switch merely moves
  // entries across.
  const mergedTotal = merged.nodes.length + (privateMerged?.nodes.length ?? 0);
  const cacheHasEntries =
    Object.keys(cached).length > 0 || Object.keys(cachedEpisodes).length > 0;
  // `deliberatelyEmpty` excuses BOTH halves of this, for the same reason it
  // excuses the planner's: the user asked. Without it the cache half still
  // fires on the load right after a delete-all, where the cache is empty but
  // some other entry is not.
  if (!deliberatelyEmpty && (plan.reason === 'wholesale-delete' || (mergedTotal === 0 && cacheHasEntries))) {
    setFavoritesSync('degraded', 'wholesale-delete');
    // eslint-disable-next-line no-console
    console.warn(
      '[favorites] REFUSING to adopt an empty merge — this device holds favorites '
      + `(cache: ${Object.keys(cached).length} feeds, ${Object.keys(cachedEpisodes).length} items; `
      + `relay: ${read.tags.filter((t) => t[0] === 'i').length} public entries, `
      + `${read.privateTags.filter((t) => t[0] === 'i').length} private) and both halves came out `
      + 'empty. Keeping local state, publishing nothing, recording no baseline.',
    );
    return;
  }


  // Set here rather than at the end of the function: everything below is
  // Podcast Index resolution, which fails for its own unrelated reasons and must
  // not be reported as "couldn't reach the relays". Set here rather than ABOVE
  // the merge, too — the refusal branch has to be able to report 'degraded'.
  setFavoritesSync('ok');

  // Rows come from BOTH halves — one library, two places it is stored. Public
  // first, so that where the same feed guid appears in both, an unambiguous
  // (itemless) public favorite is not overwritten by a private group that
  // exists only to place a track. `partitionList` is run per half rather than
  // over a spliced node list, because splicing two ordered lists would put an
  // item under whichever group happened to precede it after the join.
  const publicPart = partitionList(merged);
  const part = joinPartitions(publicPart, privateMerged ? partitionList(privateMerged) : null);

  // PUBLIC malformed only. `bmbCleanFavorites` edits `event.tags` and carries
  // `content` verbatim — it has to, since it never decrypts — so offering to
  // remove a malformed entry that lives in the private half would print a
  // count and take nothing away.
  if (publicPart.malformed.length > 0) installCleanupHook(identity, publicPart.malformed);

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
  } else if (plan.reason === 'unchanged' || plan.reason === 'nothing-to-create') {
    // The relay already agrees with us. Record the baseline: without it the
    // first unfavorite on this device has nothing to diff against and silently
    // fails to propagate.
    //
    // RECOMPUTED FROM THE PAINTED STORE, not `plan.baseline`. The plan is built
    // BEFORE the paint, on purpose, so its `local` is whatever this device held
    // when it walked in — which on a device seeing this account for the first
    // time is NOTHING. The list it then adopts off the relay would therefore be
    // recorded as "I published none of this".
    //
    // Harmless while a list has only a public half: an empty baseline yields no
    // removals, so the next publish is a pure union, and the spec says so
    // outright. It stops being harmless the moment there are two halves. A mode
    // switch expresses itself as a REMOVAL from one half and an addition to the
    // other, and a baseline naming nothing cannot remove anything — so the
    // switch copies instead of moving, and the favorites the user just asked to
    // hide stay in plaintext `i` tags beside the encrypted copy. Reported from a
    // real account: 12 entries, public and private at once.
    //
    // Recording it is truthful rather than optimistic: this ran on a
    // TRUSTWORTHY read, and every id came off the relay a moment ago. "I agree
    // with the relay about these" is exactly what a baseline claims.
    // `plan.baseline` is now derived from the MERGED halves rather than from
    // the pre-paint store, so it already describes what this device has just
    // adopted — in the half each entry actually lives in. Recomputing it here
    // from the store would put everything in the current mode's half and
    // disown the other, which is the bug this replaced.
    syncOptionsFor(identity).onSynced(plan.baseline);
  } else {
    // A REFUSAL. Record nothing, and say so.
    //
    // This branch used to be the `else` above, so every reason that is not a
    // publish recorded a baseline — including the two the planner invents to
    // refuse one. A baseline is a promise that these ids are already asserted,
    // so recording it for entries that never left the device makes `local −
    // baseline` empty for them from then on and they are NEVER PUBLISHED
    // AGAIN, while the UI reports success. That is the same permanent loss
    // `assertPublished` exists to prevent.
    //
    // Reached today by 'private-too-large' — the read was fine and the rows are
    // painted, so this deliberately does not return early; only the promise is
    // withheld.
    setFavoritesSync('degraded', plan.reason);
    // eslint-disable-next-line no-console
    console.warn(`[favorites] not recording a baseline — the planner refused this publish (${plan.reason})`);
  }
}

/**
 * Two partitioned halves, rendered as one library.
 *
 * Public first and private second, so a `for` loop that skips a duplicate feed
 * guid keeps the FIRST verdict: an itemless public group is an unambiguous
 * favorite, and a private group carrying items may exist only to place a track.
 * Order is the tie-break, and it is the safe way round.
 */
function joinPartitions(pub: PartitionedList, priv: PartitionedList | null): PartitionedList {
  if (!priv) return pub;
  return {
    feeds: [...pub.feeds, ...priv.feeds],
    items: [...pub.items, ...priv.items],
    loose: [...pub.loose, ...priv.loose],
    malformed: [...pub.malformed, ...priv.malformed],
  };
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
        // `read.content` verbatim: this hook edits the PUBLIC half only, and
        // rewriting a private half it never decrypted would delete it.
        await publishFavoritesTags(tagsFromList(kept), read.content, relays);
      } catch (e) {
        // Reporting "removed N" for an event no relay took would be a lie the
        // user acts on — they'd stop running it. The baseline below stays
        // unwritten either way, so a retry is still a real retry.
        return `nothing removed — ${(e as Error)?.message ?? e}`;
      }
      storage.favBaseline.set(
        identity.npub,
        favoritesMode(identity.npub) === 'private'
          ? baselineForHalves(EMPTY_LOCAL, localFavoriteList())
          : baselineForHalves(localFavoriteList(), EMPTY_LOCAL),
      );
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
