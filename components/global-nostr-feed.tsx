'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  fetchAllPodcastNotes,
  useNostrFeed,
  type DiscoveredNote,
} from '@/lib/nostr';
import { storage } from '@/lib/storage';
import { useApp } from '@/lib/store';
import type { Podcast, StoredBoost } from '@/lib/types';
import { FeedSection } from './feed-section';
import { NoteCard } from './nostr-note-card';
import { BoostCard } from './boost-card';

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

// Discriminated union of feed items. `ts` is unix ms across both kinds so
// they sort cleanly. Notes use `createdAt * 1000`; stored boosts use the
// timestamp captured when the user clicked Send.
type FeedItem =
  | { kind: 'note'; ts: number; key: string; note: DiscoveredNote }
  | { kind: 'boost'; ts: number; key: string; boost: StoredBoost };

/**
 * Global stream of every kind:1 note tagged with NIP-73 podcast identifiers
 * across all podcasts and clients, **intermixed** with the user's own
 * locally-saved sent boosts (BoostBox + keysend). When a sent boost has
 * already been published to Nostr and discovered on the relays, the Nostr
 * version wins (it carries author profile, replies, zap target).
 */
export function GlobalNostrFeed() {
  const { notes, loading, err, refresh } = useNostrFeed({
    cacheKey: 'global',
    fetcher: fetchAllPodcastNotes,
  });
  const [podcasts, setPodcasts] = useState<Record<string, Podcast | null>>({});
  const identity = useApp((s) => s.identity);
  const boostsTick = useApp((s) => s.boostsTick);

  // Re-read the localStorage log whenever a boost is sent or the active
  // identity changes. Per-npub key isolation is handled by storage.boosts.
  const storedBoosts = useMemo<StoredBoost[]>(
    () => storage.boosts.get(identity?.npub),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity?.npub, boostsTick],
  );

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

  const merged = useMemo<FeedItem[] | null>(() => {
    if (notes === null) {
      // Still surface the user's own log while the relay query is in flight.
      if (storedBoosts.length === 0) return null;
      return storedBoosts.map((b) => ({
        kind: 'boost' as const,
        ts: b.ts,
        key: `boost:${b.uuid}`,
        boost: b,
      }));
    }
    const noteIds = new Set(notes.map((n) => n.id));
    const items: FeedItem[] = notes.map((note) => ({
      kind: 'note' as const,
      ts: note.createdAt * 1000,
      key: `note:${note.id}`,
      note,
    }));
    for (const b of storedBoosts) {
      // Dedupe: drop the local entry if its published note already came back
      // from a relay — the discovered NoteCard is richer.
      if (b.noteId && noteIds.has(b.noteId)) continue;
      items.push({
        kind: 'boost' as const,
        ts: b.ts,
        key: `boost:${b.uuid}`,
        boost: b,
      });
    }
    items.sort((a, b) => b.ts - a.ts);
    return items;
  }, [notes, storedBoosts]);

  return (
    <FeedSection<FeedItem>
      heading={
        <h2 className="font-display text-2xl">
          <span className="text-nostr">#</span> Global boost feed
        </h2>
      }
      description={
        <p className="text-xs text-muted mb-4">
          Every public Nostr post tagged with a Podcasting 2.0 <code>podcast:guid</code> identifier
          — boosts, comments, and chatter from any client following the convention (Fountain,
          Wavlake, BoostMeBitch, etc.). Your own sends are intermixed locally, with BoostBox
          metadata links where available.
        </p>
      }
      notes={merged}
      loading={loading}
      err={err}
      emptyMessage="no nostr activity surfaced from these relays yet."
      onRefresh={refresh}
      itemKey={(item) => item.key}
      renderNote={(item) =>
        item.kind === 'note' ? (
          <NoteCard
            note={item.note}
            podcast={item.note.podcastGuid ? podcasts[item.note.podcastGuid] ?? null : null}
          />
        ) : (
          <BoostCard boost={item.boost} />
        )
      }
    />
  );
}
