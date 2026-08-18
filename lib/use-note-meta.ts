'use client';
import { useEffect, useRef, useState } from 'react';
import { piMaybeUp, resolveEpisodeByGuid, resolvePodcastByGuid } from '@/lib/podcast-meta';
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
 *  - **The attempted-sets are refs, not state.** Putting them in the dep array
 *    beside the effect's own `setPodcasts` created a fetch storm, where
 *    cancelled-but-already-in-flight requests kept hitting the network on every
 *    render cycle. One attempt per key for the life of the tab.
 *  - **`cancelled` guards every setState**, so a resolve that lands after the
 *    list changed doesn't write stale metadata over the new one.
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
  }, [items]);

  // Same again for the episode each item was boosted from — probe-first, one
  // attempt per pair for the life of the tab, breaker-gated. Only the title is
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
    let cancelled = false;
    (async () => {
      const [[firstKey, firstRef], ...rest] = entries;
      const firstEpisode = await resolveEpisodeByGuid(firstRef.feedGuid, firstRef.itemGuid);
      if (cancelled) return;
      setEpisodes((prev) => ({ ...prev, [firstKey]: firstEpisode }));
      if (!piMaybeUp()) return;
      const restEpisodes = await Promise.all(
        rest.map(([, r]) => resolveEpisodeByGuid(r.feedGuid, r.itemGuid)),
      );
      if (cancelled) return;
      setEpisodes((prev) => {
        const next = { ...prev };
        rest.forEach(([k], i) => { next[k] = restEpisodes[i]; });
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [items]);

  return { podcasts, episodes };
}
