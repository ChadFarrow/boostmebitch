'use client';

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Event } from 'nostr-tools';
import { createBoundedCache } from './bounded-cache';
import type { NostrIdentity } from './nostr/auth';
import { tallyLikes, type LikeTally } from './nostr/like-tally';
import { fetchEpisodeLikes, publishEpisodeLike, publishEpisodeUnlike } from './nostr/likes';
import { resolvePublishRelays } from './nostr/relays';
import { useApp } from './store';

/**
 * One episode's likes, shared by every surface that shows them.
 *
 * **One store, not one `useState` per tile**, because two tiles show the same
 * episode at once — the episode page and the fullscreen player's ⋯ menu — and
 * a like pressed in one must turn the other on. It also makes the read happen
 * once per episode rather than once per mount. → docs/nostr.md, "Episode likes".
 */

interface LikeEntry {
  /** The last relay read: every kind:17 and kind:5 filed under the episode. */
  read: Event[];
  /** The read's `complete` — see `EpisodeLikesRead`. */
  complete: boolean;
  /** No read has settled yet. */
  loading: boolean;
  /**
   * Events THIS TAB published since — kept apart from `read` so a read that
   * started before the press, and lands after it, cannot take the like back
   * off the tile while it propagates. The next read normally carries them too;
   * the tally dedupes by id.
   */
  mine: Event[];
}

/** A read younger than this is reused, so reopening an episode costs nothing. */
const FRESH_MS = 60_000;

// Keyed by a feed-supplied guid, so bounded — CLAUDE.md, "one place per thing".
const cache = createBoundedCache<LikeEntry>({ maxAgeMs: 30 * 60_000, maxEntries: 100 });
const inflight = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

function entryFor(itemGuid: string): LikeEntry | undefined {
  return cache.get(itemGuid, Date.now())?.value;
}

function put(itemGuid: string, entry: LikeEntry): void {
  cache.set(itemGuid, entry, Date.now());
  for (const l of listeners.get(itemGuid) ?? []) l();
}

function load(itemGuid: string, viewer: string | null): void {
  const hit = cache.get(itemGuid, Date.now());
  if (inflight.has(itemGuid) || (hit && hit.ageMs < FRESH_MS)) return;
  inflight.add(itemGuid);
  if (!hit) put(itemGuid, { read: [], complete: false, loading: true, mine: [] });
  fetchEpisodeLikes(itemGuid, viewer)
    .then(
      (r) => put(itemGuid, { read: r.events, complete: r.complete, loading: false, mine: entryFor(itemGuid)?.mine ?? [] }),
      // A failed read keeps what it had and claims nothing: `complete: false`.
      () => {
        const prev = entryFor(itemGuid);
        put(itemGuid, { read: prev?.read ?? [], complete: false, loading: false, mine: prev?.mine ?? [] });
      },
    )
    .finally(() => inflight.delete(itemGuid));
}

function addMine(itemGuid: string, e: Event): void {
  const prev = entryFor(itemGuid) ?? { read: [], complete: false, loading: false, mine: [] };
  put(itemGuid, { ...prev, mine: [...prev.mine, e] });
}

export interface EpisodeLikes {
  /** `null` until the first read settles. */
  tally: LikeTally | null;
  /** Every relay that connected answered. */
  complete: boolean;
}

/** Read — and keep reading — one episode's likes. `undefined` reads nothing. */
export function useEpisodeLikes(itemGuid: string | undefined): EpisodeLikes {
  const viewer = useApp((s) => s.identity?.pubkey ?? null);
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!itemGuid) return () => {};
      let set = listeners.get(itemGuid);
      if (!set) listeners.set(itemGuid, (set = new Set()));
      set.add(cb);
      return () => {
        set.delete(cb);
        if (set.size === 0) listeners.delete(itemGuid);
      };
    },
    [itemGuid],
  );
  const entry = useSyncExternalStore(
    subscribe,
    () => (itemGuid ? entryFor(itemGuid) : undefined),
    () => undefined,
  );
  useEffect(() => {
    if (itemGuid) load(itemGuid, viewer);
  }, [itemGuid, viewer]);
  const tally = useMemo(() => {
    if (!itemGuid || !entry || entry.loading) return null;
    const byId = new Map<string, Event>();
    for (const e of [...entry.read, ...entry.mine]) byId.set(e.id, e);
    return tallyLikes([...byId.values()], itemGuid, viewer);
  }, [entry, itemGuid, viewer]);
  return { tally, complete: entry?.complete ?? false };
}

/** Publish a like and put it on every tile showing this episode. Throws on a
 *  refusal or when no relay accepted it — the tile shows that, and changes
 *  nothing. */
export async function likeEpisode(args: {
  itemGuid: string;
  feedGuid: string;
  identity: NostrIdentity;
}): Promise<void> {
  const note = await publishEpisodeLike({
    itemGuid: args.itemGuid,
    feedGuid: args.feedGuid,
    relays: resolvePublishRelays(args.identity),
  });
  addMine(args.itemGuid, note.event);
}

/** Publish the deletion of `likeIds` and take the like off every tile. */
export async function unlikeEpisode(args: {
  itemGuid: string;
  likeIds: readonly string[];
  identity: NostrIdentity;
}): Promise<void> {
  const note = await publishEpisodeUnlike({
    itemGuid: args.itemGuid,
    likeIds: args.likeIds,
    relays: resolvePublishRelays(args.identity),
  });
  addMine(args.itemGuid, note.event);
}
