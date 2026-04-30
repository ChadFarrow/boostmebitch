'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchAllPodcastNotes,
  useNostrFeed,
  type DiscoveredNote,
} from '@/lib/nostr';
import { piMaybeUp, resolvePodcastByGuid } from '@/lib/podcast-meta';
import { storage } from '@/lib/storage';
import { useApp } from '@/lib/store';
import type { Podcast, StoredBoost } from '@/lib/types';
import { FeedSection } from './feed-section';
import { NoteCard } from './nostr-note-card';
import { BoostCard } from './boost-card';

// UUID-shaped podcast:guid filter. Some clients post boost notes with
// non-UUID values in the i-tag (feed IDs, episode strings); those will
// never resolve via PI's /podcasts/byguid endpoint, so we drop them at
// the source instead of round-tripping a 404.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  // Tracks guids we've already kicked off a resolve for. Lives in a ref
  // (not state) so updating it doesn't re-fire the effect — putting it in
  // deps with the effect's own setPodcasts created a fetch storm where
  // cancelled-but-already-in-flight requests kept hitting the network on
  // every render cycle.
  const attempted = useRef<Set<string>>(new Set());
  const identity = useApp((s) => s.identity);
  const boostsTick = useApp((s) => s.boostsTick);

  // Re-read the localStorage log whenever a boost is sent or the active
  // identity changes. Per-npub key isolation is handled by storage.boosts.
  const storedBoosts = useMemo<StoredBoost[]>(
    () => storage.boosts.get(identity?.npub),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity?.npub, boostsTick],
  );

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
    const items: FeedItem[] = notes.map((note) => ({
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
