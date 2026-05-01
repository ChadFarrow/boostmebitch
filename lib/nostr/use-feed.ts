'use client';
import { useEffect, useRef, useState } from 'react';
import { storage } from '../storage';
import type { DiscoveredNote } from './discover';

/**
 * Stale-while-revalidate hook for any DiscoveredNote[] surface.
 *
 *   - Initial render is deterministic (`notes === null`) so SSR and client
 *     produce matching markup — no hydration mismatch.
 *   - Right after mount, read `storage.feedNotes.get(cacheKey)` so revisits
 *     paint cached notes within one frame instead of through the empty
 *     "searching nostr relays…" state for the full network round-trip.
 *   - Re-seed + re-fetch whenever any of `deps` change (the per-podcast feed
 *     passes `[podcastGuid]`; the global feed passes `[]`).
 *   - `refresh()` is incremental: it asks the relay for events newer than
 *     the freshest one we already have (`since: maxCreatedAt + 1`) and
 *     prepends new ones onto the existing list. Faster + uses less relay
 *     bandwidth than re-downloading the whole feed. The first load (or any
 *     load with no notes yet) falls back to a full fetch.
 *   - Cache the merged result on every successful load.
 */
export function useNostrFeed({
  cacheKey,
  fetcher,
  deps = [],
}: {
  cacheKey: string;
  fetcher: (opts?: { since?: number }) => Promise<DiscoveredNote[]>;
  deps?: unknown[];
}): {
  notes: DiscoveredNote[] | null;
  loading: boolean;
  err: string | null;
  refresh: () => Promise<void>;
} {
  const [notes, setNotes] = useState<DiscoveredNote[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Mirror of `notes` in a ref so refresh() can read the current list
  // without depending on the closure that captured the empty initial state.
  const notesRef = useRef<DiscoveredNote[] | null>(null);
  notesRef.current = notes;

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const current = notesRef.current;
      const newest = current && current.length > 0
        ? current.reduce((max, n) => (n.createdAt > max ? n.createdAt : max), 0)
        : 0;
      // +1 so the relay doesn't redundantly re-send the newest known event.
      const since = newest > 0 ? newest + 1 : undefined;
      const result = await fetcher(since !== undefined ? { since } : undefined);

      let merged: DiscoveredNote[];
      if (since !== undefined && current) {
        const seen = new Set(current.map((n) => n.id));
        const novel = result.filter((n) => !seen.has(n.id));
        merged = [...novel, ...current];
      } else {
        merged = result;
      }
      setNotes(merged);
      storage.feedNotes.set(cacheKey, merged);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed to load nostr feed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const cached = storage.feedNotes.get(cacheKey);
    if (cached) {
      setNotes(cached);
      notesRef.current = cached;
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { notes, loading, err, refresh };
}
