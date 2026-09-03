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
  fetcher: (opts?: {
    since?: number;
    /** Called with the top-level notes the moment the relay scan returns,
     *  before the reply / profile / quote stages. Optional on purpose — the
     *  boost-explorer fetchers must not implement it (see `FetchOpts.onRoots`),
     *  and a fetcher that ignores it simply commits once at the end. */
    onRoots?: (roots: DiscoveredNote[]) => void;
  }) => Promise<DiscoveredNote[]>;
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
    // `loading` means "there is nothing to show yet", NOT "a fetch is running".
    // Anything else makes it a claim the screen contradicts: the index pass
    // commits a full feed in well under a second while the relay pass runs on
    // for tens of seconds, and clearing this only in the relay `finally` left
    // the control reading `loading…` and DISABLED over a feed the reader was
    // already scrolling. The relay pass keeps going and keeps committing —
    // `mergeNotes` unions by id, so a later answer can only add to what is on
    // screen, never take it away, which is what makes an early clear safe.
    setLoading(false);
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
      // Three commits on a cold relay-only load, not one: the roots as soon as
      // the kind:1 scan returns, then the assembled tree. `commit` unions by
      // id, so each can only add.
      const result = await fetcher({ onRoots: (roots) => commit(roots, myGen) });
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
 *
 * **Except that a wholesale replace does not deliver that, which is the whole
 * reason `richer` exists.** Every commit is one pass's best answer about the
 * same immutable event, and the passes do not arrive in order of how much they
 * know: the index answers in tens of milliseconds with profiles and a whole
 * reply forest, and the relay pass then paints its top-level notes seconds
 * later carrying neither. Replacing on id made that a downgrade the reader
 * watches happen — an avatar and a thread that were on screen vanish and only
 * return when the last relay stage finishes, which is exactly the "profiles
 * load slowly" this is downstream of. So the newer copy wins field by field,
 * and only where it actually has something.
 */
function mergeNotes(existing: DiscoveredNote[], incoming: DiscoveredNote[]): DiscoveredNote[] {
  if (!existing.length) return incoming;
  const byId = new Map<string, DiscoveredNote>();
  for (const n of existing) byId.set(n.id, n);
  for (const n of incoming) {
    const prev = byId.get(n.id);
    byId.set(n.id, prev ? richer(prev, n) : n);
  }
  return Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The newer copy of one note, with anything the older copy knew and it doesn't.
 *
 * A kind:1 is immutable, so the two copies differ only in how much enrichment
 * the pass that produced them had done. Nothing here can be legitimately
 * *withdrawn* by a later pass; each field below is one a pass either resolved
 * or never looked up.
 *
 *  - `author` — the profile stage; null until a kind:0 lands.
 *  - `replies` — the reply-tree stage; empty on a root-only paint.
 *  - `amountMsat` / `isBoost` — adopted from a quoted kind:9735 for a Fountain
 *    wrapper note, which needs the quoted-event stage. `isBoost` also gates
 *    `noteHasSubstance`, so losing it takes the whole note off the feed.
 */
function richer(existing: DiscoveredNote, incoming: DiscoveredNote): DiscoveredNote {
  return {
    ...incoming,
    author: incoming.author ?? existing.author,
    replies: incoming.replies.length ? incoming.replies : existing.replies,
    amountMsat: incoming.amountMsat ?? existing.amountMsat,
    isBoost: incoming.isBoost || existing.isBoost,
    // Same field-by-field rule as `author`. The index pass and the relay pass
    // carry different profile sets, so one can resolve a mention the other
    // could not; replacing on id would let the later, thinner copy take a
    // resolved @name back off the screen.
    mentioned: incoming.mentioned ?? existing.mentioned,
  };
}
