'use client';

import { useEffect, useMemo, useState } from 'react';
import { resolvePodcastByGuid, warmPodcastCache } from './podcast-meta';
import { looksLikeFeedGuid } from './nostr/favorites-list';
import { mapLimit, PI_FANOUT } from './util';
import type { FavoriteEpisode } from './types';

/**
 * The PARENT FEED'S `<podcast:medium>` for favorited items that carry none —
 * FOR DISPLAY ONLY, and never written into the store.
 *
 * WHY A ROW HAS NONE. An item's medium is its parent feed's (Podcasting 2.0 has
 * no per-item one), and a heart only knows it when the surface it was pressed
 * on does. A song hearted from a `musicL` PLAYLIST row cannot take the
 * playlist's medium — the container is not the parent (`containerIsParent`) —
 * and a song hearted from a track list whose feed declared no medium has none
 * to take. Both landed under MEDIUM UNKNOWN, so the music section's SHUFFLE
 * skipped them (Chad, 2026-11-26). The hydrator fills an item's medium only
 * from its parent's OWN favorite entry, and deliberately does not fan out to
 * `/podcasts/byguid` for a hint.
 *
 * WHY NOT THE STORE. `favoriteEpisodes` is what gets published to the shared
 * kind:10333 event, and a heart re-adds a row VERBATIM (`components/lists/
 * favorites.tsx`), so a medium copied onto the row would reach the wire on the
 * next toggle — a write Chad did not ask for. The page asks this map instead
 * (`mediumOf`), and the rows stay the store's objects.
 *
 * THE COST is the batch door, once: `warmPodcastCache` answers up to 100
 * parents per request, and from memory or the 7-day `bmb:pmeta` cache for any
 * parent already seen. The resolve pass after it (CLAUDE.md: "warm first, then
 * keep the resolve pass") is bounded by `PI_FANOUT` and normally issues no
 * request at all. A parent Podcast Index does not hold, or one it could not be
 * asked about, stays absent: the row keeps "medium unknown", never a guess.
 */
export function useParentMedia(rows: FavoriteEpisode[]): ReadonlyMap<string, string> {
  const key = useMemo(() => {
    const wanted = new Set<string>();
    for (const r of rows) {
      if (!r.medium && r.feedGuid && looksLikeFeedGuid(r.feedGuid)) wanted.add(r.feedGuid);
    }
    return [...wanted].sort().join(',');
  }, [rows]);
  const [media, setMedia] = useState<ReadonlyMap<string, string>>(() => new Map());

  useEffect(() => {
    if (!key) return;
    const guids = key.split(',');
    let cancelled = false;
    void (async () => {
      await warmPodcastCache(guids);
      const found = await mapLimit(guids, PI_FANOUT, async (guid) => {
        try {
          return [guid, (await resolvePodcastByGuid(guid))?.medium] as const;
        } catch {
          return [guid, undefined] as const;
        }
      });
      if (cancelled) return;
      setMedia((prev) => {
        let next: Map<string, string> | null = null;
        for (const [guid, medium] of found) {
          if (!medium || prev.get(guid) === medium) continue;
          next ??= new Map(prev);
          next.set(guid, medium);
        }
        return next ?? prev;
      });
    })();
    return () => { cancelled = true; };
  }, [key]);

  return media;
}

/** An item row's medium for grouping: its own, else its parent feed's. */
export function displayMedium(
  row: { medium?: string; feedGuid?: string },
  parentMedia: ReadonlyMap<string, string>,
): string | undefined {
  return row.medium || (row.feedGuid ? parentMedia.get(row.feedGuid) : undefined);
}
