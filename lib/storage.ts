'use client';

// Single source of truth for the `bmb:*` localStorage namespace.
// Every browser-persisted value goes through these typed accessors so the
// raw key strings live in exactly one file and SSR/quota guards aren't
// duplicated across components.

import type { FavoritePodcast, Podcast } from './types';
import type { DiscoveredNote } from './nostr';

const KEYS = {
  npub: 'bmb:npub',
  nwcUri: 'bmb:nwc_uri',
  relays: 'bmb:relays',
  senderName: 'bmb:sender_name',
  shareNostr: 'bmb:share_nostr',
  favoritesPrefix: 'bmb:favorites',
  podcastMetaPrefix: 'bmb:pmeta',     // /api/by-guid result, keyed by guid
  feedNotesPrefix: 'bmb:feed',        // last DiscoveredNote[] per feed surface
} as const;

const isBrowser = () => typeof window !== 'undefined';

function safeGet(key: string): string | null {
  if (!isBrowser()) return null;
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeSet(key: string, value: string) {
  if (!isBrowser()) return;
  try { localStorage.setItem(key, value); } catch { /* quota etc — ignore */ }
}

function safeRemove(key: string) {
  if (!isBrowser()) return;
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

function favKey(npub: string | null | undefined) {
  return `${KEYS.favoritesPrefix}:${npub ?? 'guest'}`;
}

// Generic time-bounded cache cell. `t` is the unix-ms write time; `v` is the
// payload. Reads return null when missing, unparseable, or older than ttlMs.
interface CacheCell<T> {
  t: number;
  v: T;
}

function getTimed<T>(key: string, ttlMs: number): T | null {
  const raw = safeGet(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CacheCell<T>;
    if (!parsed || typeof parsed.t !== 'number') return null;
    if (Date.now() - parsed.t > ttlMs) return null;
    return parsed.v;
  } catch {
    return null;
  }
}

function setTimed<T>(key: string, value: T) {
  const cell: CacheCell<T> = { t: Date.now(), v: value };
  safeSet(key, JSON.stringify(cell));
}

const PODCAST_META_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const FEED_NOTES_TTL_MS = 5 * 60 * 1000;             // 5 minutes

export const storage = {
  npub: {
    get: () => safeGet(KEYS.npub),
    set: (v: string) => safeSet(KEYS.npub, v),
    clear: () => safeRemove(KEYS.npub),
  },

  nwcUri: {
    get: () => safeGet(KEYS.nwcUri),
    set: (v: string) => safeSet(KEYS.nwcUri, v),
    clear: () => safeRemove(KEYS.nwcUri),
    has: () => safeGet(KEYS.nwcUri) !== null,
  },

  /** User's publish-relay override (manual, rare). null = no override set. */
  relays: {
    get: (): string[] | null => {
      const raw = safeGet(KEYS.relays);
      if (!raw) return null;
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) && arr.length ? arr : null;
      } catch {
        return null;
      }
    },
    set: (v: string[]) => safeSet(KEYS.relays, JSON.stringify(v)),
    clear: () => safeRemove(KEYS.relays),
    /** True when an override is in effect (used by UI to label the relay source). */
    isOverridden: () => safeGet(KEYS.relays) !== null,
  },

  senderName: {
    get: () => safeGet(KEYS.senderName),
    set: (v: string) => safeSet(KEYS.senderName, v),
  },

  /**
   * Whether the boost modal defaults to publishing a Nostr note. Unset = true
   * (existing behavior); user can flip to false to make every boost private
   * (Lightning only) until they re-enable it.
   */
  shareNostr: {
    get: (): boolean => safeGet(KEYS.shareNostr) !== '0',
    set: (v: boolean) => safeSet(KEYS.shareNostr, v ? '1' : '0'),
  },

  /**
   * /api/by-guid resolutions, persisted across sessions. 7-day TTL — show
   * titles + artwork barely change so a longer window is fine, and the
   * payload is small (~200 B per guid).
   */
  podcastMeta: {
    get: (guid: string): Podcast | null =>
      getTimed<Podcast>(`${KEYS.podcastMetaPrefix}:${guid}`, PODCAST_META_TTL_MS),
    set: (guid: string, v: Podcast) =>
      setTimed(`${KEYS.podcastMetaPrefix}:${guid}`, v),
  },

  /**
   * Last DiscoveredNote[] per feed surface, used by the feeds for stale-while-
   * revalidate rendering. 5-minute TTL keeps the cached feed fresh enough that
   * the "instant render" case isn't surfacing very stale data on revisit.
   * Keys: 'global' for the global feed, 'podcast:<guid>' per podcast.
   */
  feedNotes: {
    get: (key: string): DiscoveredNote[] | null =>
      getTimed<DiscoveredNote[]>(`${KEYS.feedNotesPrefix}:${key}`, FEED_NOTES_TTL_MS),
    set: (key: string, v: DiscoveredNote[]) =>
      setTimed(`${KEYS.feedNotesPrefix}:${key}`, v),
  },

  /** Favorites are namespaced by npub; signed-out users use `:guest`. */
  favorites: {
    get: (npub: string | null | undefined): Record<string, FavoritePodcast> => {
      const raw = safeGet(favKey(npub));
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object'
          ? (parsed as Record<string, FavoritePodcast>)
          : {};
      } catch {
        return {};
      }
    },
    set: (npub: string | null | undefined, v: Record<string, FavoritePodcast>) => {
      safeSet(favKey(npub), JSON.stringify(v));
    },
  },
};
