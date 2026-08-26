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
 *   - Then the read index, if one is configured — one request that carries the
 *     notes, their whole reply forest, quoted events and author profiles.
 *   - Then relays, which stay authoritative and always run.
 *   - Re-seed + re-fetch whenever any of `deps` change (the per-podcast feed
 *     passes `[podcastGuid]`; the global feed passes `[]`).
 *   - Both mount and user-triggered `refresh()` do a full fetch (no `since`
 *     filter) so stale cached state never prevents seeing recent relay activity.
 *   - Cache the result on every successful load.
 *
 * THE THREE SOURCES UNION, THEY DO NOT REPLACE.
 *
 * The relay pass finishes many seconds after the index one and asks a different
 * question — the index holds what it has seen since it was deployed, relays
 * hold whatever each of them kept. Letting the slower answer replace the faster
 * one would make notes VANISH from a feed the user is already reading, several
 * seconds after they appeared, with nothing on screen explaining it. Notes are
 * append-only and carry their own id, so a union keyed by id is both correct
 * and the only shape that cannot lose one.
 *
 * A note the index holds and relays have dropped therefore survives. That is
 * the intended behaviour for a cache of public, immutable events; a note its
 * author actually deleted is tombstoned at ingest by the kind:5 handler, so it
 * never reaches a bundle in the first place.
 */
export function useNostrFeed({
  cacheKey,
  fetcher,
  indexFetcher,
  deps = [],
}: {
  cacheKey: string;
  fetcher: (opts?: { since?: number }) => Promise<DiscoveredNote[]>;
  /** Optional fast path. Returns null when there is no index, it is
   *  unreachable, or it has nothing — never an empty array meaning "none". */
  indexFetcher?: () => Promise<DiscoveredNote[] | null>;
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
  // What is currently on screen, readable without making `refresh` depend on
  // render state. The index and relay passes each merge into this rather than
  // replacing it.
  const shown = useRef<DiscoveredNote[]>([]);

  function commit(incoming: DiscoveredNote[], myGen: number): void {
    if (myGen !== gen.current) return; // superseded
    const merged = mergeNotes(shown.current, incoming);
    shown.current = merged;
    setNotes(merged);
    storage.feedNotes.set(cacheKey, merged);
  }

  async function refresh() {
    const myGen = ++gen.current;
    setLoading(true);
    setErr(null);

    // The index pass is fire-and-forget alongside the relay pass, not before
    // it. Awaiting it first would make an index that is merely SLOW worse than
    // no index at all — the relay query would not even have started.
    const indexPass = indexFetcher
      ? indexFetcher()
          .then((r) => { if (r?.length) commit(r, myGen); })
          .catch(() => { /* the index is never a reason to fail a feed */ })
      : Promise.resolve();

    try {
      const result = await fetcher();
      if (myGen !== gen.current) return; // superseded
      commit(result, myGen);
    } catch (e) {
      if (myGen !== gen.current) return;
      // Only surface the error if nothing is on screen. An index hit followed
      // by a relay failure is a working feed, and saying otherwise is a lie the
      // user cannot check.
      await indexPass;
      if (myGen === gen.current && !shown.current.length) {
        setErr(e instanceof Error ? e.message : 'failed to load nostr feed');
      }
    } finally {
      if (myGen === gen.current) setLoading(false);
    }
  }

  useEffect(() => {
    shown.current = [];
    const cached = storage.feedNotes.get(cacheKey);
    if (cached) {
      shown.current = cached;
      setNotes(cached);
    }
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

/**
 * Union two note lists by event id, newest first.
 *
 * `incoming` wins on a collision because it is the more recently resolved copy
 * — it carries whatever replies and profiles that pass found, and a note whose
 * author profile resolved on the second pass must not be reverted to the
 * anonymous version from the first.
 */
function mergeNotes(existing: DiscoveredNote[], incoming: DiscoveredNote[]): DiscoveredNote[] {
  if (!existing.length) return incoming;
  const byId = new Map<string, DiscoveredNote>();
  for (const n of existing) byId.set(n.id, n);
  for (const n of incoming) byId.set(n.id, n);
  return Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt);
}
