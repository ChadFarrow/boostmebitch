'use client';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { resolvePodcastByGuid, resolvePodcastByFeedUrl, piMaybeUp } from '@/lib/podcast-meta';
import { useHorizontalWheelScroll } from '@/lib/use-horizontal-wheel';
import type { Podcast, PodrollItem } from '@/lib/types';
import { PodcastCover } from './podcast-cover';
import { FavHeart } from './fav-heart';

// <podcast:podroll> — the shows the current show's host recommends. Each entry
// arrives as a feedGuid (plus an optional feedUrl hint); we resolve it to a
// full Podcast client-side (via the cached /api/by-guid resolver) and render a
// horizontal card row that mirrors the "Live on Nostr" row. Clicking a card
// opens that show's detail view through the same selectPodcast action a Nostr
// note's podcast link uses.
export function Podroll({ items }: { items: PodrollItem[] }) {
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [loading, setLoading] = useState(true);
  const selectPodcast = useApp((s) => s.selectPodcast);
  const rowRef = useHorizontalWheelScroll<HTMLDivElement>();
  // Bumped on every resolve, so only the newest one may commit. Switching shows
  // swaps `items` without unmounting this component (EpisodeList holds the
  // previous feed's data until the new fetch lands), so two resolves can
  // overlap — without this, a slow resolve for show A can settle last and paint
  // A's recommendations under show B. Also covers StrictMode's double-mount.
  const genRef = useRef(0);

  useEffect(() => {
    resolve();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // Resolve one podroll entry: feedGuid is canonical, but PI doesn't index
  // every feed by guid — so fall back to the entry's feedUrl hint when it does
  // carry one. Same PI-coverage gap that forced the RSS fallback in
  // resolveValueTimeSplits (see CLAUDE.md).
  async function resolveItem(item: PodrollItem): Promise<Podcast | null> {
    const byGuid = item.feedGuid ? await resolvePodcastByGuid(item.feedGuid) : null;
    if (byGuid) return byGuid;
    return item.feedUrl ? resolvePodcastByFeedUrl(item.feedUrl) : null;
  }

  async function resolve() {
    const gen = ++genRef.current;
    setLoading(true);
    const unique = [...new Map(items.map((i) => [i.feedGuid, i])).values()];
    // Probe-first-then-batch: resolve one, check the PI breaker, only then fan
    // out the rest — so a degraded Podcast Index isn't hammered (see CLAUDE.md).
    const resolved: Podcast[] = [];
    if (unique.length) {
      const first = await resolveItem(unique[0]);
      if (first) resolved.push(first);
      if (piMaybeUp() && unique.length > 1) {
        const rest = await Promise.all(unique.slice(1).map(resolveItem));
        for (const p of rest) if (p) resolved.push(p);
      }
    }
    if (gen !== genRef.current) return; // a newer resolve superseded us
    // De-dupe by feed id in case two entries resolve to the same show.
    setPodcasts([...new Map(resolved.map((p) => [p.id, p])).values()]);
    setLoading(false);
  }

  if (loading && !podcasts.length) {
    return (
      <section className="mt-8">
        <h3 className="font-display text-lg mb-3 text-bone/70">Recommended shows</h3>
        <div className="flex gap-3 overflow-x-auto pb-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex-shrink-0 w-64 h-24 card animate-pulse opacity-40" />
          ))}
        </div>
      </section>
    );
  }

  if (!podcasts.length) return null;

  return (
    <section className="mt-8">
      <h3 className="font-display text-lg mb-3 flex items-center gap-2">
        Recommended shows
        <span className="text-[11px] font-mono text-muted uppercase tracking-widest">
          {podcasts.length}
        </span>
      </h3>
      <div ref={rowRef} className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
        {podcasts.map((p) => (
          <article
            key={p.id}
            onClick={() => {
              selectPodcast(p);
              window.scrollTo({ top: 0 });
            }}
            className="flex-shrink-0 w-64 card p-3 flex flex-col gap-2 cursor-pointer hover:border-bone/30 transition-colors"
          >
            <div className="flex items-start gap-2">
              <PodcastCover
                image={p.image}
                artwork={p.artwork}
                title={p.title}
                seed={p.podcastGuid ?? String(p.id)}
                className="w-10 h-10 rounded object-cover flex-shrink-0"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-display leading-tight line-clamp-2" title={p.title}>
                  {p.title}
                </p>
                {p.author && <p className="text-xs text-muted truncate mt-0.5">{p.author}</p>}
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 mt-auto pt-1">
              {p.value ? (
                <span className="stamp text-bolt border-bolt/60">⚡ V4V</span>
              ) : (
                <span />
              )}
              <FavHeart podcast={p} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
