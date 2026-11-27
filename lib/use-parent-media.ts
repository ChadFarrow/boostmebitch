'use client';

import { useEffect, useMemo, useState } from 'react';
import { resolvePodcastByGuid, warmPodcastCache } from './podcast-meta';
import { looksLikeFeedGuid } from './nostr/favorites-list';
import { mapLimit, PI_FANOUT } from './util';
import type { FavoriteEpisode } from './types';

/** What a favorited item's PARENT feed says about it, as Podcast Index reports it. */
export type ParentFeed = { medium?: string; image?: string };

/** The gaps a row can have. Module-level, so a caller passes a stable function. */
export const lacksMedium = (r: FavoriteEpisode): boolean => !r.medium;
export const lacksMediumOrImage = (r: FavoriteEpisode): boolean => !r.medium || !r.image;

/**
 * The PARENT FEED'S `<podcast:medium>` and cover for favorited items that carry
 * none — FOR DISPLAY ONLY, and never written into the store.
 *
 * WHY A ROW HAS NO MEDIUM. An item's medium is its parent feed's (Podcasting 2.0
 * has no per-item one), and a heart only knows it when the surface it was
 * pressed on does. A song hearted from a `musicL` PLAYLIST row cannot take the
 * playlist's medium — the container is not the parent (`containerIsParent`) —
 * and a song hearted from a track list whose feed declared no medium has none
 * to take. Both landed under MEDIUM UNKNOWN, so the music section's SHUFFLE
 * skipped them (Chad, 2026-11-26). The hydrator fills an item's medium only
 * from its parent's OWN favorite entry, and deliberately does not fan out to
 * `/podcasts/byguid` for a hint.
 *
 * WHY A ROW HAS NO IMAGE. `<FavTrackHeart>` saves the time split's `image`,
 * which a split may not have, and the hydrator never re-resolves an item this
 * device already holds — so on that device the row stays without art for good,
 * and Add songs drew an empty square for it (Chad, 2026-11-26). The album's
 * cover is the honest fallback: it is what `favoriteFromEpisode` falls back to
 * (`ep.image || ep.feedImage`) for every item it resolves.
 *
 * WHY NOT THE STORE. `favoriteEpisodes` is what gets published to the shared
 * kind:10333 event, and a heart re-adds a row VERBATIM (`components/lists/
 * favorites.tsx`), so a field copied onto the row rides into the next toggle —
 * a write nobody asked for. The caller asks this map instead (`displayMedium`,
 * `displayImage`), and the rows stay the store's objects.
 *
 * THE COST is the batch door, once: `warmPodcastCache` answers up to 100
 * parents per request, and from memory or the 7-day `bmb:pmeta` cache for any
 * parent already seen. The resolve pass after it (CLAUDE.md: "warm first, then
 * keep the resolve pass") is bounded by `PI_FANOUT` and normally issues no
 * request at all. `wants` picks the rows worth asking about; a parent Podcast
 * Index does not hold, or one it could not be asked about, stays absent — the
 * row keeps "medium unknown" and its own art, never a guess.
 */
export function useParentFeeds(
  rows: FavoriteEpisode[],
  wants: (r: FavoriteEpisode) => boolean,
): ReadonlyMap<string, ParentFeed> {
  const key = useMemo(() => {
    const wanted = new Set<string>();
    for (const r of rows) {
      if (wants(r) && r.feedGuid && looksLikeFeedGuid(r.feedGuid)) wanted.add(r.feedGuid);
    }
    return [...wanted].sort().join(',');
  }, [rows, wants]);
  const [parents, setParents] = useState<ReadonlyMap<string, ParentFeed>>(() => new Map());

  useEffect(() => {
    if (!key) return;
    const guids = key.split(',');
    let cancelled = false;
    void (async () => {
      await warmPodcastCache(guids);
      const found = await mapLimit(guids, PI_FANOUT, async (guid) => {
        try {
          const p = await resolvePodcastByGuid(guid);
          return [guid, p ? { medium: p.medium || undefined, image: p.image || p.artwork || undefined } : null] as const;
        } catch {
          return [guid, null] as const;
        }
      });
      if (cancelled) return;
      setParents((prev) => {
        let next: Map<string, ParentFeed> | null = null;
        for (const [guid, feed] of found) {
          if (!feed || (!feed.medium && !feed.image)) continue;
          const old = prev.get(guid);
          if (old && old.medium === feed.medium && old.image === feed.image) continue;
          next ??= new Map(prev);
          next.set(guid, feed);
        }
        return next ?? prev;
      });
    })();
    return () => { cancelled = true; };
  }, [key]);

  return parents;
}

/** An item row's medium for grouping: its own, else its parent feed's. */
export function displayMedium(
  row: { medium?: string; feedGuid?: string },
  parents: ReadonlyMap<string, ParentFeed>,
): string | undefined {
  return row.medium || (row.feedGuid ? parents.get(row.feedGuid)?.medium : undefined);
}

/** An item row's art: its own, else its parent feed's cover. */
export function displayImage(
  row: { image?: string; feedGuid?: string },
  parents: ReadonlyMap<string, ParentFeed>,
): string | undefined {
  return row.image || (row.feedGuid ? parents.get(row.feedGuid)?.image : undefined);
}
