'use client';

// Single source of truth for the `bmb:*` localStorage namespace.
// Every browser-persisted value goes through these typed accessors so the
// raw key strings live in exactly one file and SSR/quota guards aren't
// duplicated across components.

import type { FavoritePodcast, Podcast, StoredBoost } from './types';
import type { DiscoveredNote, MuteListState, ProfileMetadata } from './nostr';

const KEYS = {
  npub: 'bmb:npub',
  signer: 'bmb:signer',               // 'amber' when Amber is the active signer; absent = NIP-07 extension or none
  nwcUri: 'bmb:nwc_uri',
  relays: 'bmb:relays',
  senderName: 'bmb:sender_name',
  shareNostr: 'bmb:share_nostr',
  favoritesPrefix: 'bmb:favorites',
  podcastMetaPrefix: 'bmb:pmeta',     // /api/by-guid result, keyed by guid
  feedNotesPrefix: 'bmb:feed',        // last DiscoveredNote[] per feed surface
  boostsPrefix: 'bmb:boosts',         // sent-boost log, keyed by npub or 'guest'
  profilePrefix: 'bmb:profile3',      // kind:0 metadata, keyed by pubkey (hex). Bumped on each PROFILE_RELAYS expansion so stale negative-cache entries don't pin missing profiles for the 1-hour miss TTL.
  mutedPrefix: 'bmb:muted',           // NIP-51 kind:10000 mute list cache, keyed by npub or 'guest'
} as const;

export type SignerKind = 'amber';

const BOOSTS_CAP = 200;

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

// Per-identity storage keys: signed-out users share a single `:guest` bucket;
// signed-in users get one bucket per npub. Centralized so the convention
// lives in exactly one place.
function identityKey(prefix: string, npub: string | null | undefined) {
  return `${prefix}:${npub ?? 'guest'}`;
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
const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;      // 7 days for found profiles
const PROFILE_MISS_TTL_MS = 15 * 60 * 1000;          // 15 min for known-missing — short so PROFILE_RELAYS additions / temporary relay outages re-resolve naturally on the user's next visit

// Mute-list shape coercion lives here (rather than in lib/nostr/mutes.ts) so
// the storage layer owns every legacy-format migration. Two shapes accepted:
//   - current: MuteListState directly (object with publicPubkeys etc.)
//   - legacy:  `{ pubkeys, otherTags, updatedAt }` written before the
//              public/private split — promoted to public-only.
function emptyMuteState(): MuteListState {
  return {
    publicPubkeys: [],
    publicOtherTags: [],
    privatePubkeys: [],
    privateOtherTags: [],
    updatedAt: 0,
  };
}

function coerceToMuteState(parsed: unknown): MuteListState {
  if (!parsed || typeof parsed !== 'object') return emptyMuteState();
  const p = parsed as Record<string, unknown>;
  const stringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const tagArray = (v: unknown): string[][] =>
    Array.isArray(v) ? v.filter((x): x is string[] => Array.isArray(x)) : [];
  const ts = typeof p.updatedAt === 'number' ? p.updatedAt : 0;

  // Legacy shape: only the unscoped `pubkeys` field, no `publicPubkeys`.
  if (Array.isArray(p.pubkeys) && !Array.isArray(p.publicPubkeys)) {
    return {
      publicPubkeys: stringArray(p.pubkeys),
      publicOtherTags: tagArray(p.otherTags),
      privatePubkeys: [],
      privateOtherTags: [],
      updatedAt: ts,
    };
  }

  return {
    publicPubkeys: stringArray(p.publicPubkeys),
    publicOtherTags: tagArray(p.publicOtherTags),
    privatePubkeys: stringArray(p.privatePubkeys),
    privateOtherTags: tagArray(p.privateOtherTags),
    unreadablePrivateContent:
      typeof p.unreadablePrivateContent === 'string' ? p.unreadablePrivateContent : undefined,
    updatedAt: ts,
  };
}

export const storage = {
  npub: {
    get: () => safeGet(KEYS.npub),
    set: (v: string) => safeSet(KEYS.npub, v),
    clear: () => safeRemove(KEYS.npub),
  },

  /** Which signer the user picked. Absent = NIP-07 extension or signed out;
   *  'amber' = use the Android Amber app via NIP-55 deep links. Read on page
   *  load to decide whether to install the Amber polyfill onto window.nostr. */
  signer: {
    get: (): SignerKind | null => {
      const v = safeGet(KEYS.signer);
      return v === 'amber' ? 'amber' : null;
    },
    set: (v: SignerKind) => safeSet(KEYS.signer, v),
    clear: () => safeRemove(KEYS.signer),
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
   * Last DiscoveredNote[] per feed surface. Used by `useNostrFeed` for the
   * stale-while-revalidate paint: returned regardless of age (no TTL) since
   * every mount also runs a `since`-bounded incremental refresh that
   * prepends new events. Stored as a bare array on disk; the legacy
   * `{ t, v }` wrapper from earlier versions is still accepted on read so
   * an existing user's cache survives the deploy. Keys: 'global' for the
   * global feed, 'podcast:<guid>' per podcast.
   */
  feedNotes: {
    get: (key: string): DiscoveredNote[] | null => {
      const raw = safeGet(`${KEYS.feedNotesPrefix}:${key}`);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed as DiscoveredNote[];
        if (parsed && Array.isArray(parsed.v)) return parsed.v as DiscoveredNote[];
        return null;
      } catch {
        return null;
      }
    },
    set: (key: string, v: DiscoveredNote[]) =>
      safeSet(`${KEYS.feedNotesPrefix}:${key}`, JSON.stringify(v)),
  },

  /**
   * Sent-boost log, namespaced by npub (`:guest` when signed out). Used by the
   * "view your sends" surface that intermixes with the global Nostr feed.
   * Capped at BOOSTS_CAP newest-first; oldest entries are dropped on overflow.
   */
  boosts: {
    get: (npub: string | null | undefined): StoredBoost[] => {
      const raw = safeGet(identityKey(KEYS.boostsPrefix, npub));
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as StoredBoost[]) : [];
      } catch {
        return [];
      }
    },
    set: (npub: string | null | undefined, list: StoredBoost[]) => {
      const trimmed = list.slice(0, BOOSTS_CAP);
      safeSet(identityKey(KEYS.boostsPrefix, npub), JSON.stringify(trimmed));
    },
    add: (npub: string | null | undefined, entry: StoredBoost) => {
      const list = storage.boosts.get(npub);
      storage.boosts.set(npub, [entry, ...list]);
    },
    update: (
      npub: string | null | undefined,
      uuid: string,
      patch: Partial<StoredBoost>,
    ) => {
      const list = storage.boosts.get(npub);
      const idx = list.findIndex((b) => b.uuid === uuid);
      if (idx < 0) return;
      const next = [...list];
      next[idx] = { ...next[idx], ...patch };
      storage.boosts.set(npub, next);
    },
  },

  /**
   * Per-pubkey kind:0 cache shared across every feed surface. Stores both
   * found profiles (7-day TTL) and known-missing pubkeys (1-hour negative TTL)
   * so we don't hammer relays for authors who haven't published metadata.
   *
   * `get` is tri-state:
   *   - ProfileMetadata → fresh hit, use it
   *   - null            → fresh negative hit, skip the network
   *   - undefined       → stale or never cached, caller should fetch
   */
  profile: {
    get: (pubkey: string): ProfileMetadata | null | undefined => {
      const raw = safeGet(`${KEYS.profilePrefix}:${pubkey}`);
      if (!raw) return undefined;
      try {
        const cell = JSON.parse(raw) as CacheCell<ProfileMetadata | null>;
        if (!cell || typeof cell.t !== 'number') return undefined;
        const ttl = cell.v === null ? PROFILE_MISS_TTL_MS : PROFILE_TTL_MS;
        if (Date.now() - cell.t > ttl) return undefined;
        return cell.v;
      } catch {
        return undefined;
      }
    },
    set: (pubkey: string, v: ProfileMetadata) =>
      setTimed(`${KEYS.profilePrefix}:${pubkey}`, v),
    setMiss: (pubkey: string) =>
      setTimed<ProfileMetadata | null>(`${KEYS.profilePrefix}:${pubkey}`, null),
  },

  /**
   * NIP-51 kind:10000 mute-list cache. Trafficks in `MuteListState` directly
   * (public + private p-tags, preserved non-`p` tags on each side, and any
   * opaque private-content blob we couldn't decrypt). Read also tolerates
   * the legacy `{ pubkeys, otherTags, updatedAt }` shape written by earlier
   * versions of the app — those are promoted to public-only.
   */
  muted: {
    get: (npub: string | null | undefined): MuteListState => {
      const raw = safeGet(identityKey(KEYS.mutedPrefix, npub));
      if (!raw) return emptyMuteState();
      try {
        return coerceToMuteState(JSON.parse(raw));
      } catch {
        return emptyMuteState();
      }
    },
    set: (npub: string | null | undefined, v: MuteListState) => {
      safeSet(identityKey(KEYS.mutedPrefix, npub), JSON.stringify(v));
    },
  },

  /** Favorites are namespaced by npub; signed-out users use `:guest`. */
  favorites: {
    get: (npub: string | null | undefined): Record<string, FavoritePodcast> => {
      const raw = safeGet(identityKey(KEYS.favoritesPrefix, npub));
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
      safeSet(identityKey(KEYS.favoritesPrefix, npub), JSON.stringify(v));
    },
  },
};
