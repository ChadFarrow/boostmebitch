'use client';
import { useEffect, useRef, useState } from 'react';
import {
  fetchAllPodcastNotes,
  useNostrFeed,
  type DiscoveredNote,
} from '@/lib/nostr';
import { piMaybeUp, resolvePodcastByGuid } from '@/lib/podcast-meta';
import type { Podcast } from '@/lib/types';
import { FeedSection } from './feed-section';
import { NoteCard } from './nostr-note-card';

// UUID-shaped podcast:guid filter. Some clients post boost notes with
// non-UUID values in the i-tag (feed IDs, episode strings); those will
// never resolve via PI's /podcasts/byguid endpoint, so we drop them at
// the source instead of round-tripping a 404.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Global stream of every kind:1 note tagged with NIP-73 podcast identifiers,
 * across all podcasts and clients. Each note's `podcast:guid:` reference is
 * resolved against `/api/by-guid` so the show title + artwork render as
 * context.
 */
export function GlobalNostrFeed() {
  const { notes, loading, err, refresh } = useNostrFeed({
    cacheKey: 'global',
    fetcher: fetchAllPodcastNotes,
  });
  const [podcasts, setPodcasts] = useState<Record<string, Podcast | null>>({});
  // Tracks guids we've already kicked off a resolve for. Lives in a ref
  // (not state) so updating it doesn't re-fire the effect — putting it in
  // deps with the effect's own setPodcasts created a fetch storm where
  // cancelled-but-already-in-flight requests kept hitting the network on
  // every render cycle.
  const attempted = useRef<Set<string>>(new Set());

  // Resolve podcast metadata for every unique guid in `notes`. Probe-first
  // pattern: do the first fetch sequentially so the breaker can trip before
  // the rest of the batch fires in parallel.
  useEffect(() => {
    if (!notes) return;
    const guids = Array.from(
      new Set(notes.map((n) => n.podcastGuid).filter((g): g is string => !!g)),
    ).filter((g) => UUID_RE.test(g) && !attempted.current.has(g));
    if (guids.length === 0) return;
    for (const g of guids) attempted.current.add(g);
    let cancelled = false;
    (async () => {
      const [first, ...rest] = guids;
      const firstPodcast = await resolvePodcastByGuid(first);
      if (cancelled) return;
      setPodcasts((prev) => ({ ...prev, [first]: firstPodcast }));
      if (!piMaybeUp()) return;
      const restPodcasts = await Promise.all(rest.map(resolvePodcastByGuid));
      if (cancelled) return;
      setPodcasts((prev) => {
        const next = { ...prev };
        rest.forEach((g, i) => { next[g] = restPodcasts[i]; });
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [notes]);

  return (
    <FeedSection
      heading={
        <h2 className="font-display text-2xl">
          <span className="text-nostr">#</span> Global boost feed
        </h2>
      }
      description={
        <p className="text-xs text-muted mb-4">
          Every public Nostr post tagged with a Podcasting 2.0 <code>podcast:guid</code> identifier
          — boosts, comments, and chatter from any client following the convention (Fountain,
          Wavlake, BoostMeBitch, etc.).
        </p>
      }
      notes={notes}
      loading={loading}
      err={err}
      emptyMessage="no nostr activity surfaced from these relays yet."
      onRefresh={refresh}
      renderNote={(n: DiscoveredNote) => (
        <NoteCard
          key={n.id}
          note={n}
          podcast={n.podcastGuid ? podcasts[n.podcastGuid] ?? null : null}
        />
      )}
    />
  );
}
