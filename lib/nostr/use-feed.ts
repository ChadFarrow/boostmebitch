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
 *   - Both mount and user-triggered `refresh()` do a full fetch (no `since`
 *     filter) so stale cached state never prevents seeing recent relay activity.
 *   - Cache the result on every successful load.
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
  // Monotonic generation. Two fetches can overlap — a fast podcast switch, or a
  // mount-refresh racing a user refresh() — and whichever resolved LAST would
  // otherwise win, so a slow fetch for podcast A could overwrite podcast B's
  // notes. Only the newest generation commits; the effect cleanup bumps it so
  // an in-flight fetch also can't setState after unmount / deps change.
  const gen = useRef(0);

  async function refresh() {
    const myGen = ++gen.current;
    setLoading(true);
    setErr(null);
    try {
      const result = await fetcher();
      if (myGen !== gen.current) return; // superseded
      setNotes(result);
      storage.feedNotes.set(cacheKey, result);
    } catch (e) {
      if (myGen !== gen.current) return;
      setErr(e instanceof Error ? e.message : 'failed to load nostr feed');
    } finally {
      if (myGen === gen.current) setLoading(false);
    }
  }

  useEffect(() => {
    const cached = storage.feedNotes.get(cacheKey);
    if (cached) setNotes(cached);
    refresh();
    // Bump the invalidation counter on cleanup so any in-flight fetch bails.
    // `gen` is a plain counter ref (not a DOM node), so the exhaustive-deps
    // "ref may have changed" heuristic doesn't apply — changing it is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { gen.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { notes, loading, err, refresh };
}
