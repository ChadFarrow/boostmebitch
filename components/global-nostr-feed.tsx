'use client';
import { useMemo } from 'react';
import {
  fetchAllPodcastNotes,
  noteHasSubstance,
  useNostrFeed,
  useViewerReposts,
  type DiscoveredNote,
} from '@/lib/nostr';
import { episodeRefOf, useNoteMeta } from '@/lib/use-note-meta';
import { storage } from '@/lib/storage';
import { useApp } from '@/lib/store';
import type { StoredBoost } from '@/lib/types';
import { FeedSection } from './feed-section';
import { NoteCard } from './nostr-note-card';
import { BoostCard } from './boost-card';

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
  // Show + episode titles for every note's NIP-73 guids. Shared with the boost
  // explorer, which needs the same probe-first-then-batch PI resolution.
  const { podcasts, episodes } = useNoteMeta(notes);
  const identity = useApp((s) => s.identity);
  const boostsTick = useApp((s) => s.boostsTick);
  const mutedPubkeys = useApp((s) => s.mutedPubkeys);
  const repostedIds = useViewerReposts(notes, identity);

  // Re-read the localStorage log whenever a boost is sent or the active
  // identity changes. Per-npub key isolation is handled by storage.boosts.
  const storedBoosts = useMemo<StoredBoost[]>(
    () => storage.boosts.get(identity?.npub),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity?.npub, boostsTick],
  );

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
    const items: FeedItem[] = notes
      .filter((note) => !mutedPubkeys.has(note.pubkey))
      .filter(noteHasSubstance)
      .map((note) => ({
        kind: 'note' as const,
        ts: note.createdAt * 1000,
        key: `note:${note.id}`,
        note,
      }));
    for (const b of storedBoosts) {
      // Dedupe: once we've published the boost note, hide the local card.
      // The user's NIP-65 write set may not intersect DEFAULT_RELAYS (used
      // by fetchAllPodcastNotes), so we can't rely on the discovered set
      // catching every published boost — but we'd rather risk a missing
      // card than a permanent duplicate. Failed publishes leave noteId
      // undefined and surface as locals indefinitely.
      if (b.noteId) continue;
      items.push({
        kind: 'boost' as const,
        ts: b.ts,
        key: `boost:${b.uuid}`,
        boost: b,
      });
    }
    items.sort((a, b) => b.ts - a.ts);
    return items;
  }, [notes, storedBoosts, mutedPubkeys]);

  return (
    <FeedSection<FeedItem>
      heading={
        <h2 className="font-display text-2xl">
          <span className="text-nostr">#</span> Global boost feed
        </h2>
      }
      notes={merged}
      loading={loading}
      err={err}
      emptyMessage="no nostr activity surfaced from these relays yet."
      onRefresh={refresh}
      itemKey={(item) => item.key}
      renderNote={(item) => {
        if (item.kind !== 'note') return <BoostCard boost={item.boost} />;
        const ref = episodeRefOf(item.note);
        return (
          <NoteCard
            note={item.note}
            podcast={item.note.podcastGuid ? podcasts[item.note.podcastGuid] ?? null : null}
            episode={ref ? episodes[ref.key] ?? null : null}
            repostedIds={repostedIds}
          />
        );
      }}
    />
  );
}
