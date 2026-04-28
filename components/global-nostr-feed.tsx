'use client';
import { useEffect, useState } from 'react';
import {
  fetchAllPodcastNotes,
  useNostrFeed,
  type DiscoveredNote,
} from '@/lib/nostr';
import { storage } from '@/lib/storage';
import type { Podcast } from '@/lib/types';
import { FeedSection } from './feed-section';
import { NoteCard } from './nostr-note-card';

// In-memory mirror of storage.podcastMeta — avoids re-parsing localStorage on
// every NoteCard render within the same page session.
const podcastMem = new Map<string, Podcast | null>();

async function resolvePodcast(guid: string): Promise<Podcast | null> {
  if (podcastMem.has(guid)) return podcastMem.get(guid) ?? null;
  const cached = storage.podcastMeta.get(guid);
  if (cached) {
    podcastMem.set(guid, cached);
    return cached;
  }
  try {
    const r = await fetch(`/api/by-guid?guid=${encodeURIComponent(guid)}`);
    if (!r.ok) {
      podcastMem.set(guid, null);
      return null;
    }
    const { podcast } = (await r.json()) as { podcast: Podcast };
    if (podcast) {
      podcastMem.set(guid, podcast);
      storage.podcastMeta.set(guid, podcast);
      return podcast;
    }
    podcastMem.set(guid, null);
    return null;
  } catch {
    podcastMem.set(guid, null);
    return null;
  }
}

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

  // Resolve podcast metadata for every unique guid that appears in `notes` —
  // covers both the SWR cache paint and every refresh.
  useEffect(() => {
    if (!notes) return;
    const guids = Array.from(
      new Set(notes.map((n) => n.podcastGuid).filter((g): g is string => !!g)),
    );
    for (const guid of guids) {
      if (guid in podcasts) continue;
      resolvePodcast(guid).then((p) => {
        setPodcasts((prev) => ({ ...prev, [guid]: p }));
      });
    }
  }, [notes, podcasts]);

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
