'use client';
import { useEffect, useRef, useState } from 'react';
import {
  piMaybeUp,
  resolveEpisodeByGuid,
  resolvePodcastByGuid,
  warmEpisodeCache,
  warmPodcastCache,
} from '@/lib/podcast-meta';
import type { Episode, Podcast } from '@/lib/types';

// UUID-shaped podcast:guid filter. Some clients post boost notes with
// non-UUID values in the i-tag (feed IDs, episode strings); those will
// never resolve via PI's /podcasts/byguid endpoint, so we drop them at
// the source instead of round-tripping a 404.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The NIP-73 refs a feed item carries. Deliberately a plain shape rather than
 * `DiscoveredNote`, so a zap receipt — which carries the same two fields, read
 * off the embedded kind:9734 — can feed the same resolver.
 */
export interface NoteRefs {
  podcastGuid: string | null;
  episodeGuids: string[];
}

/**
 * The (show, item) pair an item names, or null when it names no single episode.
 * BOTH halves are required — PI's /episodes/byguid disambiguates an item guid
 * by its podcastguid — and the show guid goes through the same UUID filter the
 * podcast resolve uses, so a client's non-UUID i-tag isn't round-tripped to a
 * 404. Exactly one item guid, deliberately: a note tagging several (a boost-all
 * across an album's tracks) is not about one episode, and picking the first
 * would print a track the user didn't single out and link somewhere they
 * didn't boost. The show line is the honest label there.
 */
export function episodeRefOf(
  refs: NoteRefs,
): { feedGuid: string; itemGuid: string; key: string } | null {
  const feedGuid = refs.podcastGuid;
  if (refs.episodeGuids.length !== 1) return null;
  const itemGuid = refs.episodeGuids[0];
  if (!feedGuid || !itemGuid || !UUID_RE.test(feedGuid)) return null;
  return { feedGuid, itemGuid, key: `${feedGuid}:${itemGuid}` };
}

/**
 * Resolve Podcast Index metadata for every show and episode a list of feed
 * items names, so cards can print "→ show · episode" instead of a bare guid.
 *
 * Extracted from `<GlobalNostrFeed>` when the boost explorer needed the same
 * thing. It is not a `useMemo` around a fetch — every property below was a bug
 * fixed in place, and a second hand-rolled copy would have to re-find them:
 *
 *  - **Probe first, then batch.** The first resolve runs alone so the
 *    client-side Podcast Index breaker can trip before the rest fire in
 *    parallel; `piMaybeUp()` gates the batch. Without it one outage costs N
 *    parallel failures instead of one.
 *  - **The batch is a real batch.** `warm*Cache` fills `podcastMem`/`episodeMem`
 *    100 guids per request, and the `resolve*` calls after it are then cache
 *    hits that touch no network. "Batch" used to mean `Promise.all` over N
 *    single-guid routes, which on a 100-note global feed was ~100 requests
 *    against `/api/by-guid` and `/api/episode-by-guid`, drained six at a time
 *    per host — competing with the relay sockets and the artwork for the same
 *    connections on the one page that mounts every feed at once.
 *    The `resolve*` pass is KEPT rather than replaced: warming is best-effort
 *    and records nothing it could not ask for, so a failed or partial warm has
 *    to fall through to the per-entry path or the row silently stays a guid.
 *  - **The attempted-sets are refs, not state.** Putting them in the dep array
 *    beside the effect's own `setPodcasts` created a fetch storm, where
 *    cancelled-but-already-in-flight requests kept hitting the network on every
 *    render cycle. One attempt per key.
 *  - **A SUPERSEDED RUN STILL WRITES ITS ANSWER, and a key it did not answer
 *    for is RELEASED.** These two are one rule seen from both ends, and the
 *    thing they protect is not freshness — it is that the attempted-set is the
 *    ONLY reader this data has. See {@link record} below.
 *
 * A miss is ordinary and renders as the show line alone: PI has not crawled
 * every independent release, which is exactly the audience this app exists for.
 */
export function useNoteMeta(items: NoteRefs[] | null): {
  podcasts: Record<string, Podcast | null>;
  episodes: Record<string, Episode | null>;
} {
  const [podcasts, setPodcasts] = useState<Record<string, Podcast | null>>({});
  const attempted = useRef<Set<string>>(new Set());
  // Same shape one level down, for the episode each item names. Keyed
  // `<feedGuid>:<itemGuid>` because PI can't look an item up without its show.
  const [episodes, setEpisodes] = useState<Record<string, Episode | null>>({});
  const attemptedEpisodes = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!items) return;
    const guids = Array.from(
      new Set(items.map((n) => n.podcastGuid).filter((g): g is string => !!g)),
    ).filter((g) => UUID_RE.test(g) && !attempted.current.has(g));
    if (guids.length === 0) return;
    for (const g of guids) attempted.current.add(g);
    (async () => {
      const [first, ...rest] = guids;
      const firstPodcast = await resolvePodcastByGuid(first);
      record(setPodcasts, attempted, [[first, firstPodcast]]);
      // The breaker is open, so `rest` was never asked about. Hand the keys
      // back — `resetPiBreaker()` or a later commit is what retries them.
      if (!piMaybeUp()) return release(attempted, rest);
      await warmPodcastCache(rest);
      const restPodcasts = await Promise.all(rest.map(resolvePodcastByGuid));
      record(setPodcasts, attempted, rest.map((g, i) => [g, restPodcasts[i]]));
    })();
  }, [items]);

  // Same again for the episode each item was boosted from — probe-first, one
  // attempt per pair until something answers, breaker-gated. Only the title is
  // wanted here; opening the row goes back to `/api/feed` for the real episode
  // (see <NoteCard>'s handler), because PI's indexed record carries no value
  // block.
  useEffect(() => {
    if (!items) return;
    const pending = new Map<string, { feedGuid: string; itemGuid: string }>();
    for (const n of items) {
      const ref = episodeRefOf(n);
      if (!ref || attemptedEpisodes.current.has(ref.key)) continue;
      pending.set(ref.key, ref);
    }
    if (pending.size === 0) return;
    for (const key of pending.keys()) attemptedEpisodes.current.add(key);
    const entries = [...pending.entries()];
    (async () => {
      const [[firstKey, firstRef], ...rest] = entries;
      const firstEpisode = await resolveEpisodeByGuid(firstRef.feedGuid, firstRef.itemGuid);
      record(setEpisodes, attemptedEpisodes, [[firstKey, firstEpisode]]);
      if (!piMaybeUp()) return release(attemptedEpisodes, rest.map(([k]) => k));
      await warmEpisodeCache(rest.map(([, r]) => r));
      const restEpisodes = await Promise.all(
        rest.map(([, r]) => resolveEpisodeByGuid(r.feedGuid, r.itemGuid)),
      );
      record(setEpisodes, attemptedEpisodes, rest.map(([k], i) => [k, restEpisodes[i]]));
    })();
  }, [items]);

  return { podcasts, episodes };
}

/** A `useRef` set, typed without naming React's ref type. */
type KeySet = { current: Set<string> };

/**
 * Write what an attempt answered, and hand back every key it did not answer for.
 *
 * ── Why the write is unconditional ───────────────────────────────────────────
 *
 * This used to be guarded by a `cancelled` flag set from the effect's cleanup,
 * on the reasoning that a resolve landing after the list changed must not write
 * stale metadata. THERE IS NO STALE WRITE AVAILABLE HERE. Both maps are keyed
 * by the guid the answer is about and both consumers look their own key up
 * (`podcasts[note.podcastGuid] ?? null`), so a late answer can only fill in the
 * entry it names. It cannot overwrite a different note's.
 *
 * What the guard actually did was throw the answer away, because the key was
 * already in the attempted-set and NOTHING RE-READS IT. `useNostrFeed` commits
 * a cold feed four times — the localStorage cache, the index pass, the relay
 * roots, then the assembled tree — and each commit is a new `notes` array, so
 * the effect's cleanup fired on a resolve that was mid-flight. The second run
 * then found every key already attempted and returned immediately.
 *
 * The data was not even missing: `warmEpisodeCache` had already filled
 * `episodeMem`, so the answer sat in the module cache with no reader left. That
 * is the shape of the report — one note kept the plain "→ show · author" line
 * with no episode card, a reload reproduced it exactly, and navigating away and
 * back fixed it instantly and with no network, because a remount is a fresh
 * attempted-set reading the cache that was filled the first time.
 *
 * ── Why a null hands the key back ────────────────────────────────────────────
 *
 * `resolvePodcastByGuid` / `resolveEpisodeByGuid` return null for two different
 * things, and lib/podcast-meta.ts is careful to cache only one of them: PI
 * answering "not found" is cached, while a 429 from our own rate limiter, a
 * timeout, an aborted fetch or an open breaker is left UNCACHED so that a retry
 * can still resolve it. Keeping the key means that retry never happens — the
 * one guard downstream of every rule in that file.
 *
 * Releasing on ANY null is what makes this cheap enough to be unconditional. A
 * genuine "not found" is in `podcastMem`/`episodeMem`, so the next run answers
 * it from memory and issues no request at all; only the entries that were never
 * asked about reach the network a second time. The retry is bounded by how many
 * times the note list commits, not by the render count.
 */
function record<T>(
  set: (updater: (prev: Record<string, T | null>) => Record<string, T | null>) => void,
  attempted: KeySet,
  answers: [string, T | null][],
): void {
  set((prev) => {
    const next = { ...prev };
    for (const [key, value] of answers) next[key] = value;
    return next;
  });
  release(attempted, answers.filter(([, v]) => v === null).map(([k]) => k));
}

/** Let these keys be asked about again on the next commit. */
function release(attempted: KeySet, keys: string[]): void {
  for (const key of keys) attempted.current.delete(key);
}
