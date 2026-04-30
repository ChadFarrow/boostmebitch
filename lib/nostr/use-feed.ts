'use client';
import { useEffect, useState } from 'react';
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
 *   - Cache the new result on every successful load.
 */
export function useNostrFeed({
  cacheKey,
  fetcher,
  deps = [],
}: {
  cacheKey: string;
  fetcher: () => Promise<DiscoveredNote[]>;
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

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const result = await fetcher();
      setNotes(result);
      storage.feedNotes.set(cacheKey, result);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed to load nostr feed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const cached = storage.feedNotes.get(cacheKey);
    if (cached) setNotes(cached);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { notes, loading, err, refresh };
}
