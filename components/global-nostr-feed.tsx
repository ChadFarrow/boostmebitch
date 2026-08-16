'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchAllPodcastNotes,
  noteHasSubstance,
  useNostrFeed,
  useViewerReposts,
  type DiscoveredNote,
} from '@/lib/nostr';
import { piMaybeUp, resolveEpisodeByGuid, resolvePodcastByGuid } from '@/lib/podcast-meta';
import { storage } from '@/lib/storage';
import { useApp } from '@/lib/store';
import type { Episode, Podcast, StoredBoost } from '@/lib/types';
import { FeedSection } from './feed-section';
import { NoteCard } from './nostr-note-card';
import { BoostCard } from './boost-card';

// UUID-shaped podcast:guid filter. Some clients post boost notes with
// non-UUID values in the i-tag (feed IDs, episode strings); those will
// never resolve via PI's /podcasts/byguid endpoint, so we drop them at
// the source instead of round-tripping a 404.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The (show, item) pair a note names, or null when it names no single episode.
 * BOTH halves are required — PI's /episodes/byguid disambiguates an item guid
 * by its podcastguid — and the show guid goes through the same UUID filter the
 * podcast resolve uses, so a client's non-UUID i-tag isn't round-tripped to a
 * 404. Exactly one item guid, deliberately: a note tagging several (a boost-all
 * across an album's tracks) is not about one episode, and picking the first
 * would print a track the user didn't single out and link somewhere they
 * didn't boost. The show line is the honest label there.
 */
function episodeRefOf(
  note: DiscoveredNote,
): { feedGuid: string; itemGuid: string; key: string } | null {
  const feedGuid = note.podcastGuid;
  if (note.episodeGuids.length !== 1) return null;
  const itemGuid = note.episodeGuids[0];
  if (!feedGuid || !itemGuid || !UUID_RE.test(feedGuid)) return null;
  return { feedGuid, itemGuid, key: `${feedGuid}:${itemGuid}` };
}

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
  // Same shape one level down, for the episode each note names. Keyed
  // `<feedGuid>:<itemGuid>` because PI can't look an item up without its show.
  const [episodes, setEpisodes] = useState<Record<string, Episode | null>>({});
  const attemptedEpisodes = useRef<Set<string>>(new Set());
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

  // Same again for the episode each note was boosted from — probe-first, one
  // attempt per pair for the life of the tab, breaker-gated. Only the title is
  // wanted here; opening the row goes back to `/api/feed` for the real episode
  // (see <NoteCard>'s handler), because PI's indexed record carries no value
  // block. Misses are ordinary: PI hasn't crawled every independent release,
  // and the row just falls back to the show author it showed before.
  useEffect(() => {
    if (!notes) return;
    const pending = new Map<string, { feedGuid: string; itemGuid: string }>();
    for (const n of notes) {
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
