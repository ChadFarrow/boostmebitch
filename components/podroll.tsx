'use client';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { resolvePodcastByGuid, piMaybeUp } from '@/lib/podcast-meta';
import type { Podcast, PodrollItem } from '@/lib/types';
import { PodcastCover } from './podcast-cover';
import { FavHeart } from './lists';

// <podcast:podroll> — the shows the current show's host recommends. Each entry
// arrives as a raw feedGuid; we resolve it to a full Podcast client-side (via
// the cached /api/by-guid resolver) and render a horizontal card row that
// mirrors the "Live on Nostr" row. Clicking a card opens that show's detail
// view through the same selectPodcast action a Nostr note's podcast link uses.
export function Podroll({ items }: { items: PodrollItem[] }) {
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [loading, setLoading] = useState(true);
  const selectPodcast = useApp((s) => s.selectPodcast);
  const mountedRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Translate vertical mouse-wheel into horizontal scroll over the row (copied
  // from nostr-live-streams). React's onWheel is passive, so attach natively.
  // Only hijack when overflowing, the gesture is vertical, and not at the edge.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const atStart = el.scrollLeft <= 0;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
      if ((e.deltaY < 0 && atStart) || (e.deltaY > 0 && atEnd)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [podcasts.length]);

  useEffect(() => {
    mountedRef.current = true;
    resolve();
    return () => {
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  async function resolve() {
    setLoading(true);
    // feedGuid is canonical; entries with only a feedUrl aren't resolvable here.
    const guids = [...new Set(items.map((i) => i.feedGuid).filter(Boolean))];
    // Probe-first-then-batch: resolve one, check the PI breaker, only then fan
    // out the rest — so a degraded Podcast Index isn't hammered (see CLAUDE.md).
    const resolved: Podcast[] = [];
    if (guids.length) {
      const first = await resolvePodcastByGuid(guids[0]);
      if (first) resolved.push(first);
      if (piMaybeUp() && guids.length > 1) {
        const rest = await Promise.all(guids.slice(1).map((g) => resolvePodcastByGuid(g)));
        for (const p of rest) if (p) resolved.push(p);
      }
    }
    if (!mountedRef.current) return;
    // De-dupe by feed id in case two entries resolve to the same show.
    const seen = new Set<number>();
    setPodcasts(resolved.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true))));
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
      <div ref={scrollRef} className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
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
