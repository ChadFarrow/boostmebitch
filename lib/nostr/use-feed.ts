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
 *   - Mount auto-refresh is incremental: asks for events since the newest
 *     cached one (`since: maxCreatedAt + 1`) and prepends new ones. Faster
 *     and uses less relay bandwidth than re-downloading the whole feed.
 *   - `refresh()` (user-triggered) always does a full fetch with no `since`
 *     filter so stale cached state never prevents seeing recent relay activity.
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
  // Mirror of `notes` in a ref so fetchAndMerge() can read the current list
  // without depending on the closure that captured the empty initial state.
  const notesRef = useRef<DiscoveredNote[] | null>(null);
  notesRef.current = notes;

  async function fetchAndMerge(since?: number) {
    setLoading(true);
    setErr(null);
    try {
      const current = notesRef.current;
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

  // User-triggered refresh always does a full fetch (no `since`) so the stale
  // cached newest-event timestamp never blocks seeing recent relay activity.
  async function refresh() {
    await fetchAndMerge();
  }

  useEffect(() => {
    const cached = storage.feedNotes.get(cacheKey);
    if (cached) {
      setNotes(cached);
      notesRef.current = cached;
    }
    // Mount: incremental — only pull events newer than what's already cached.
    const current = notesRef.current;
    const newest = current && current.length > 0
      ? current.reduce((max, n) => (n.createdAt > max ? n.createdAt : max), 0)
      : 0;
    const since = newest > 0 ? newest + 1 : undefined;
    fetchAndMerge(since);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { notes, loading, err, refresh };
}
