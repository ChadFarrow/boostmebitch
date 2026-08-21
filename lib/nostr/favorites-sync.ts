'use client';

// The glue between the store's two favorite maps and the one shared kind:10333
// list on Nostr. Kept apart from `favorites.ts` so that module stays pure wire
// format + merge (and stays pinnable by scripts/check-favsync.mjs), and apart
// from `favorites-hydrator.ts` so <FavHeart> doesn't have to import the
// hydration path just to schedule a publish.

import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { resolvePublishRelays } from './relays';
import { createScheduledPublish } from './debounced-publish';
import {
  groupLocalFavorites,
  itemId,
  showId,
  syncFavorites,
  type FavoriteEntry,
  type LocalList,
  type SyncOptions,
} from './favorites';
// Straight from the import-free leaf rather than through './favorites': the
// predicate is pure and pinned by check:favsync, and routing it through the
// module that owns the network calls would only widen what this file depends on.
import {
  baselineIsTrustworthy,
  EMPTY_BASELINE,
  type FavoritesBaseline,
} from './favorites-list';
import type { NostrIdentity } from './auth';

/**
 * This device's favorites as flat wire entries — both maps in one list, because
 * they share one Nostr event.
 *
 * An episode carries its parent feed guid, without which it cannot be grouped
 * (and cannot be resolved through PI, which needs a `podcastguid`). One with no
 * parent is not dropped: `groupLocalFavorites` keeps it as an orphan ahead of
 * the groups, because losing a track because we can't name its album is a worse
 * trade than an unplaceable entry.
 *
 * Neither carries a feed URL. `FavoritePodcast.url` and `FavoriteEpisode.feedUrl`
 * are still populated and still used for rendering — kind:10333 simply has no
 * slot for one, an `i` tag there being bare.
 */
export function localFavoriteEntries(): FavoriteEntry[] {
  const state = useApp.getState();
  const entries: FavoriteEntry[] = [];
  for (const fav of Object.values(state.favorites)) {
    entries.push({ id: showId(fav.podcastGuid), medium: fav.medium });
  }
  for (const ep of Object.values(state.favoriteEpisodes)) {
    entries.push({ id: itemId(ep.itemGuid), feedRef: ep.feedGuid, medium: ep.medium });
  }
  return entries;
}

/** The same, grouped for the wire. */
export function localFavoriteList(): LocalList {
  return groupLocalFavorites(localFavoriteEntries());
}

/**
 * The stored baseline, or an empty one when it cannot be believed.
 *
 * Both reads are per-npub localStorage. See `baselineIsTrustworthy` for why the
 * pair can fall out of step and why the empty answer is the safe one.
 */
export function trustedBaseline(npub: string): FavoritesBaseline {
  const baseline = storage.favBaseline.get(npub);
  const localHasEntries =
    Object.keys(storage.favorites.get(npub)).length > 0
    || Object.keys(storage.favoriteEpisodes.get(npub)).length > 0;
  if (baselineIsTrustworthy(baseline, localHasEntries)) return baseline;
  // eslint-disable-next-line no-console
  console.warn(
    '[favorites] ignoring the baseline this cycle — it names '
    + `${baseline.feeds.length + baseline.items.length} id(s) while this device caches none. `
    + 'Treating every entry on the relay as another writer\'s rather than as our removal.',
  );
  return EMPTY_BASELINE;
}

export function syncOptionsFor(identity: NostrIdentity): SyncOptions {
  return {
    pubkey: identity.pubkey,
    relays: resolvePublishRelays(identity),
    // Getters, not values: the debounce re-reads at fire time, so a burst of
    // heart-taps publishes once with the final set.
    local: localFavoriteList,
    baseline: () => trustedBaseline(identity.npub),
    // Both callbacks also move `favoritesSync`, so the whole feature reports its
    // relay health from one place: hydration routes its own success through this
    // same `onSynced` (see favorites-hydrator.ts), and a publish that lands is
    // proof the relays are answering again — it clears a notice an earlier
    // degraded read put up.
    //
    // ONE flag, where there used to be two. That is not a simplification of the
    // old rule but its replacement: two flags existed because two events could
    // fail independently, and a single flag across them let a good read on one
    // clear a notice the other's failure had raised. There is one event now, so
    // a partial failure is not expressible and a single flag cannot lie.
    onSynced: (baseline) => {
      storage.favBaseline.set(identity.npub, baseline);
      useApp.getState().setFavoritesSync('ok');
    },
    onDegraded: () => useApp.getState().setFavoritesSync('degraded'),
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
