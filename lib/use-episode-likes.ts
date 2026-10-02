'use client';

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Event } from 'nostr-tools';
import { createBoundedCache } from './bounded-cache';
import type { NostrIdentity } from './nostr/auth';
import { tallyLikes, type LikeTally } from './nostr/like-tally';
import { fetchEpisodeLikes, publishEpisodeLike, publishEpisodeUnlike } from './nostr/likes';
import { NoRelayAcceptedError, SignStoppedError } from './nostr/publish';
import { resolvePublishRelays } from './nostr/relays';
import { getErrorMessage } from './util';
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
  /**
   * Whose likes the read looked for. The viewer's own read only runs for a
   * signed-in viewer, so an entry read signed out — or as somebody else — says
   * nothing about THIS viewer's like, however fresh it is.
   */
  viewer: string | null;
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

/**
 * Read one episode's likes unless a fresh read is already in hand.
 *
 * Fresh means young, settled, and read FOR THIS VIEWER. Without the last test a
 * sign-in within a minute of a signed-out read reused it — and that read never
 * looked for the viewer's own like, so on a capped episode, or with a relay
 * override, the tile read un-liked and the next press published a second like.
 * Signing OUT reuses any read: the count does not depend on who asked.
 */
function load(itemGuid: string, viewer: string | null, ownRelays: readonly string[]): void {
  const hit = cache.get(itemGuid, Date.now());
  // A `loading` entry with nothing in flight is one `addMine` made with no read
  // behind it — fresh by age, and still owed a read.
  const fresh = hit && !hit.value.loading && hit.ageMs < FRESH_MS && (viewer === null || hit.value.viewer === viewer);
  if (inflight.has(itemGuid) || fresh) return;
  inflight.add(itemGuid);
  if (!hit) put(itemGuid, { read: [], complete: false, loading: true, mine: [], viewer });
  fetchEpisodeLikes(itemGuid, viewer, ownRelays)
    .then(
      (r) => put(itemGuid, { read: r.events, complete: r.complete, loading: false, mine: entryFor(itemGuid)?.mine ?? [], viewer }),
      // A failed read keeps what it had and claims nothing: `complete: false`.
      () => {
        const prev = entryFor(itemGuid);
        put(itemGuid, { read: prev?.read ?? [], complete: false, loading: false, mine: prev?.mine ?? [], viewer });
      },
    )
    .finally(() => inflight.delete(itemGuid));
}

/**
 * Record an event this tab published. **With no entry it starts a read rather
 * than invent one.** The entry can be gone while a tile is mounted — the cache
 * drops it at its horizon — and `{ read: [], loading: false }` would tally the
 * viewer's own like as the only one: an episode 49 people liked reading "1".
 */
function addMine(itemGuid: string, e: Event, ownRelays: readonly string[]): void {
  const prev = entryFor(itemGuid);
  if (!prev) {
    put(itemGuid, { read: [], complete: false, loading: true, mine: [e], viewer: e.pubkey });
    load(itemGuid, e.pubkey, ownRelays);
    return;
  }
  put(itemGuid, { ...prev, mine: [...prev.mine, e] });
}

export interface EpisodeLikes {
  /** `null` until the first read settles. */
  tally: LikeTally | null;
  /** Every relay that connected answered. */
  complete: boolean;
}

/**
 * Read — and keep reading — one episode's likes. `undefined` reads nothing.
 * `feedGuid` is the item's parent feed, which decides which of the viewer's
 * likes this tile may take back (`tallyLikes`).
 */
export function useEpisodeLikes(itemGuid: string | undefined, feedGuid?: string | null): EpisodeLikes {
  const identity = useApp((s) => s.identity);
  const viewer = identity?.pubkey ?? null;
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
  // A settled entry read for somebody else — signed out, or before a sign-in
  // that landed while the read was in flight — never looked for THIS viewer's
  // own like.
  const otherViewer = !!entry && !entry.loading && viewer !== null && entry.viewer !== viewer;
  // `owed` is a dependency on purpose. The cache drops an entry at its horizon
  // INSIDE `getSnapshot`, and the episode page renders on every playback tick,
  // so 30 minutes into a long episode the entry vanishes under a mounted tile;
  // and a sign-in during a read leaves a settled entry read for nobody. Without
  // this nothing reads again — the tile forgets or never finds the viewer's
  // like, and their next press publishes a second one instead of taking it back.
  const owed = entry === undefined || otherViewer;
  useEffect(() => {
    // Where the viewer PUBLISHES, so their own read can look there too when it
    // is not where the count looks (`viewerLikeRelays`).
    if (itemGuid) load(itemGuid, viewer, identity ? resolvePublishRelays(identity) : []);
  }, [itemGuid, viewer, owed, identity]);
  const tally = useMemo(() => {
    if (!itemGuid || !entry || entry.loading) return null;
    // Not a tally for this viewer yet: `null` keeps the tile disabled rather
    // than offering LIKE to somebody whose like the read never looked for.
    if (otherViewer) return null;
    const byId = new Map<string, Event>();
    for (const e of [...entry.read, ...entry.mine]) byId.set(e.id, e);
    return tallyLikes([...byId.values()], itemGuid, viewer, feedGuid ?? null);
  }, [entry, itemGuid, viewer, feedGuid, otherViewer]);
  return { tally, complete: entry?.complete ?? false };
}

/** Publish a like and put it on every tile showing this episode. Throws on a
 *  refusal or when no relay accepted it — the tile shows that, and changes
 *  nothing. */
export async function likeEpisode(args: {
  itemGuid: string;
  feedGuid: string;
  identity: NostrIdentity;
  signal?: AbortSignal;
}): Promise<void> {
  const relays = resolvePublishRelays(args.identity);
  const note = await publishEpisodeLike({ itemGuid: args.itemGuid, feedGuid: args.feedGuid, relays, signal: args.signal });
  addMine(args.itemGuid, note.event, relays);
}

/** Publish the deletion of `likeIds` and take the like off every tile. */
export async function unlikeEpisode(args: {
  itemGuid: string;
  likeIds: readonly string[];
  identity: NostrIdentity;
  signal?: AbortSignal;
}): Promise<void> {
  const relays = resolvePublishRelays(args.identity);
  const note = await publishEpisodeUnlike({ itemGuid: args.itemGuid, likeIds: args.likeIds, relays, signal: args.signal });
  addMine(args.itemGuid, note.event, relays);
}

/**
 * What a failed press says, as text under the tile. A phone shows no `title`,
 * so this is the only place the reason can be read there — and the three
 * causes need different things from the listener: a signer that refused, one
 * that never answered, and relays that took nothing.
 */
export function likeFailureText(err: unknown, unlike: boolean): string {
  const what = unlike ? 'unlike' : 'like';
  if (err instanceof SignStoppedError) return 'Stopped waiting for the signer. Nothing was published.';
  if (err instanceof NoRelayAcceptedError) return `No relay accepted the ${what}.`;
  return `The ${what} failed: ${getErrorMessage(err, 'unknown error')}`;
}
