'use client';

import { useMemo } from 'react';
import { useApp } from '@/lib/store';
import { isDemuFeed } from '@/lib/demu';
import { closedService } from '@/lib/moved-feeds';
import { SAVED_MATCH_THIN, matchSavedShows, savedShows } from '@/lib/saved-show-search';
import type { Podcast } from '@/lib/types';
import { matchesSearchType } from '@/lib/util';
import type { SearchType } from '@/lib/util';
import { PodcastRow } from './podcast-results';

/**
 * "From your saved shows": the favorites and played shows a THIN search
 * reaches by a typo or a substring, under Podcast Index's rows.
 *
 * Below the search's own rows and its empty sentence, never above or among
 * them: Podcast Index's answer is still the answer, and this section is a
 * second, local one, labelled as such. It renders nothing while a search is in
 * flight (the parent does not mount it), when the search returned
 * `SAVED_MATCH_THIN` rows or more, and when nothing saved matches — so a device
 * with nothing saved searches exactly as before. docs/ui.md, "Typo matches from
 * your saved shows".
 *
 * `type` is the type the SERVER applied (`SearchInfo.type`), so the section
 * narrows by the same lane as the rows above it. `matchesSearchType` is only
 * the MUSIC half of `'demu'`; the self-hosted half is `isDemuFeed`, which the
 * search route applies to its own rows and this applies to the saved ones. A
 * saved copy carries no `generator`, so under DEMU it fails closed and the
 * section stays empty: a Wavlake album listed under DEMU tells a listener it may
 * be requested on Homegrown Hits, which plays only DeMu.
 */
export function SavedShowMatches({
  query,
  listed,
  type,
  onSelect,
}: {
  query: string;
  listed: Podcast[];
  type: SearchType;
  onSelect: (p: Podcast) => void;
}) {
  const favorites = useApp((s) => s.favorites);
  const history = useApp((s) => s.playHistory);
  const shows = useMemo(() => savedShows(favorites, history), [favorites, history]);
  const matches = useMemo(
    () => (!query.trim() || listed.length >= SAVED_MATCH_THIN
      ? []
      : matchSavedShows(shows.filter((p) => matchesSearchType(p, type)
        && (type !== 'demu' || isDemuFeed(p, closedService))), query, listed)),
    [shows, query, listed, type],
  );
  if (!matches.length) return null;
  return (
    <section aria-labelledby="saved-show-matches" className="mt-2 border-t border-bone/10 pt-3" data-saved-matches>
      <h2 id="saved-show-matches" className="text-[11px] uppercase tracking-widest text-muted mb-1 px-1 font-normal">
        from your saved shows
      </h2>
      {/* The same row as a search result, so it opens and hearts the same way.
          No ⚡ V4V stamp: a saved copy carries no value block, the same reason
          `/favorites` turns it off. The two-column grid from lg: matches
          `<PodcastResults>` above. */}
      <ul className="max-lg:divide-y max-lg:divide-bone/10 lg:grid lg:grid-cols-2 lg:gap-x-6 lg:[&>li]:border-b lg:[&>li]:border-bone/10">
        {matches.map((p) => (
          <PodcastRow
            key={p.podcastGuid ?? p.url ?? String(p.id)}
            podcast={p}
            selected={false}
            onSelect={onSelect}
            showV4VStamp={false}
          />
        ))}
      </ul>
    </section>
  );
}
