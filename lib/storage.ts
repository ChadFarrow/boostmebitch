'use client';

// Single source of truth for the `bmb:*` localStorage namespace.
// Every browser-persisted value goes through these typed accessors so the
// raw key strings live in exactly one file and SSR/quota guards aren't
// duplicated across components.

import type { Episode, FavoritePodcast, Podcast, StoredBoost } from './types';
import type { DiscoveredNote, MuteListState, ProfileMetadata } from './nostr';
import { coerceProfileMetadata } from './nostr/auth';
import { createObservable } from './pubsub';

// Rail-pref changes need to reach live UI (account-menu summary, balance
// chip, open wallet modal) no matter who wrote them — recordLastRail after
// a boost, the Nostr settings restore in loadProfile, or the wallet modal's
// switch picker. Notifying from the setter is the one choke point that
// covers every writer.
const railPrefObservable = createObservable();
export const subscribeRailPref = railPrefObservable.subscribe;

const KEYS = {
  npub: 'bmb:npub',
  signer: 'bmb:signer',               // 'amber' | 'bunker' when a polyfill signer is active; absent = NIP-07 extension or none
  nwcUri: 'bmb:nwc_uri',
  relays: 'bmb:relays',
  senderName: 'bmb:sender_name',
  shareNostr: 'bmb:share_nostr',
  shareNostrAs: 'bmb:share_nostr_as', // 'site' when a signed-in user prefers boost notes signed by the site key; absent = own key
  favoritesPrefix: 'bmb:favorites',
  inboxSeenPrefix: 'bmb:inbox_seen',  // per-npub set of "seen"/handled episode keys for the Inbox (string[] on disk)
  listenQueuePrefix: 'bmb:listen_queue', // per-npub ordered listen queue ({ episode, podcast }[]); survives reload
  podcastMetaPrefix: 'bmb:pmeta',     // /api/by-guid result, keyed by guid
  feedNotesPrefix: 'bmb:feed',        // last DiscoveredNote[] per feed surface
  socialThreadPrefix: 'bmb:social',   // last DiscoveredNote[] per podcast:socialInteract URI
  boostsPrefix: 'bmb:boosts',         // sent-boost log, keyed by npub or 'guest'
  profilePrefix: 'bmb:profile4',      // kind:0 metadata, keyed by pubkey (hex). Bumped on each PROFILE_RELAYS expansion — and here, to flush negative-cache entries poisoned by a relay-stall bug — so stale misses don't pin missing profiles for the miss TTL.
  mutedPrefix: 'bmb:muted',           // NIP-51 kind:10000 mute list cache, keyed by npub or 'guest'
  bunker: 'bmb:bunker',               // NIP-46 bunker session: { uri, clientSk } — single value (one bunker connection at a time)
  railPref: 'bmb:rail_pref',          // user's preferred boost rail; absent = follow pickRail() priority. 'nwc' | 'spark' | 'webln'.
  walletBalancePrefix: 'bmb:wallet_balance', // last-known balance + rail per npub, used to paint the header chip instantly while the SDK / NWC client reconnects on page load
  nwcBackupPrefix: 'bmb:nwc_backup',  // per-npub '1' when the user opted in to backing up their NWC connection string to Nostr (kind:30078, boostmebitch:wallet:nwc)
  followsPrefix: 'bmb:follows',       // per-npub last-known-good kind:3 follow set (hex[]) — a nuke-guard signal, see lib/nostr/follows.ts
  sparkOptOut: 'bmb:spark:opted_out', // set when user explicitly disconnects Spark or replaces a CONNECTED Spark with another rail; suppresses auto-restore on next login. Never set when Spark wasn't connected (connecting NWC/WebLN on a Spark-less device must not block a later restore). Cleared by every Spark connect path.
  theme: 'bmb:theme',                 // 'light' when user chose light mode; absent = dark (default). FOUC-blocker in app/layout.tsx reads this synchronously to set data-theme on <html> before paint.
} as const;

export type RailPref = 'nwc' | 'spark' | 'webln';
export type ShareNostrAs = 'self' | 'site';
export type ThemeMode = 'light' | 'dark';
export interface CachedWalletBalance { rail: RailPref; balance: number; ts: number }

export type SignerKind = 'amber' | 'bunker';

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

// Per-key memory fallback for the few critical writes that need to survive
// a hostile localStorage (iOS Safari Private Browsing, "Block All Cookies",
// content blockers — all silently no-op `setItem`). Living next to the
// safe* helpers so each storage accessor can opt in by mirroring its writes
// here. Lost on page reload — the storage block is the user's to fix —
// but at least the wallet works for the current session.
const memoryFallback: { nwcUri: string | null } = { nwcUri: null };

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
   *  'amber' = Android Amber app via NIP-55 deep links;
   *  'bunker' = NIP-46 remote signer via the persisted bunker session.
   *  Read on page load to decide which polyfill to install onto window.nostr. */
  signer: {
    get: (): SignerKind | null => {
      const v = safeGet(KEYS.signer);
      if (v === 'amber') return 'amber';
      if (v === 'bunker') return 'bunker';
      return null;
    },
    set: (v: SignerKind) => safeSet(KEYS.signer, v),
    clear: () => safeRemove(KEYS.signer),
  },

  /** NIP-46 bunker session. `uri` is the original bunker:// (or the
   *  nostrconnect:// we generated, in which case parsing back to a
   *  BunkerPointer is done from the URI on reload); `clientSk` is the
   *  hex-encoded client secret key used to encrypt the DM transport with
   *  the bunker. Persisting clientSk lets us reconnect across reloads
   *  without the bunker treating us as a brand-new client. */
  bunker: {
    get: (): { uri: string; clientSk: string } | null => {
      const raw = safeGet(KEYS.bunker);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        if (typeof parsed.uri !== 'string' || typeof parsed.clientSk !== 'string') return null;
        return { uri: parsed.uri, clientSk: parsed.clientSk };
      } catch {
        return null;
      }
    },
    set: (v: { uri: string; clientSk: string }) =>
      safeSet(KEYS.bunker, JSON.stringify(v)),
    clear: () => safeRemove(KEYS.bunker),
  },

  nwcUri: {
    get: () => safeGet(KEYS.nwcUri) ?? memoryFallback.nwcUri,
    set: (v: string) => {
      // Memory fallback first so the value is queryable even if the
      // localStorage write silently fails (iOS Safari Private Browsing /
      // "Block All Cookies" / aggressive content blockers all silently no-op
      // setItem). Without this, the URI is "saved" to nowhere and the wallet
      // modal bounces back to the connect form with no recovery path.
      memoryFallback.nwcUri = v;
      safeSet(KEYS.nwcUri, v);
    },
    clear: () => {
      memoryFallback.nwcUri = null;
      safeRemove(KEYS.nwcUri);
    },
    has: () => (safeGet(KEYS.nwcUri) ?? memoryFallback.nwcUri) !== null,
    /** True if the URI is only held in memory — i.e. the localStorage write
     *  failed and the user will lose it on reload. Used to show a soft
     *  "won't persist across reloads" hint. */
    isEphemeral: () => memoryFallback.nwcUri !== null && safeGet(KEYS.nwcUri) === null,
  },

  /**
   * User's preferred boost rail. Set when they pick a rail in the boost
   * modal's picker so the next boost defaults to the same wallet. Falls
   * back to `pickRail()` priority (NWC > Spark > WebLN) when unset or
   * when the preferred rail is no longer available.
   */
  railPref: {
    get: (): RailPref | null => {
      const v = safeGet(KEYS.railPref);
      if (v === 'nwc' || v === 'spark' || v === 'webln') return v;
      return null;
    },
    set: (v: RailPref) => { safeSet(KEYS.railPref, v); railPrefObservable.notify(); },
    clear: () => { safeRemove(KEYS.railPref); railPrefObservable.notify(); },
  },

  sparkOptOut: {
    get: () => safeGet(KEYS.sparkOptOut) === '1',
    set: () => safeSet(KEYS.sparkOptOut, '1'),
    clear: () => safeRemove(KEYS.sparkOptOut),
  },

  /** Per-npub opt-in flag: '1' when the user wants their NWC connection
   *  string encrypted and backed up to Nostr (kind:30078). Absent = off
   *  (the default — an NWC URI is a spending credential). */
  nwcBackup: {
    get: (npub: string | null | undefined) =>
      safeGet(identityKey(KEYS.nwcBackupPrefix, npub)) === '1',
    set: (npub: string | null | undefined) =>
      safeSet(identityKey(KEYS.nwcBackupPrefix, npub), '1'),
    clear: (npub: string | null | undefined) =>
      safeRemove(identityKey(KEYS.nwcBackupPrefix, npub)),
  },

  /**
   * Per-npub last-known-good follow set (hex pubkeys) — a nuke-guard signal for
   * kind:3, NOT used for rendering. Written only from a REAL kind:3 (never a
   * possibly-false-empty fetch), so a non-empty value here that contradicts a
   * live empty read is strong evidence of a transient false-empty; toggleFollow
   * then refuses to publish onto it rather than overwrite the real list.
   */
  follows: {
    get: (npub: string | null | undefined): string[] | null => {
      const raw = safeGet(identityKey(KEYS.followsPrefix, npub));
      if (!raw) return null;
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? (arr as string[]) : null;
      } catch { return null; }
    },
    set: (npub: string | null | undefined, hexes: string[]) =>
      safeSet(identityKey(KEYS.followsPrefix, npub), JSON.stringify(hexes)),
    clear: (npub: string | null | undefined) =>
      safeRemove(identityKey(KEYS.followsPrefix, npub)),
  },

  /** Per-device theme preference. Absent = dark (the app default). Only
   *  'light' is ever written; flipping back to dark removes the key so
   *  there's a single sentinel state for "default". */
  theme: {
    get: (): ThemeMode => (safeGet(KEYS.theme) === 'light' ? 'light' : 'dark'),
    set: (v: ThemeMode) => {
      if (v === 'light') safeSet(KEYS.theme, 'light');
      else safeRemove(KEYS.theme);
    },
  },

  /**
   * Last-known wallet balance + the rail it came from, per npub. Used by
   * the header chip + boost-modal balance to paint a number instantly on
   * page load while the underlying SDK reconnects (Breez Spark's WASM load
   * + connect + sync can take 5-10 s; NWC's first RPC has its own latency).
   * The cached value is replaced as soon as a fresh fetch lands.
   */
  walletBalance: {
    get: (npub: string | null | undefined): CachedWalletBalance | null => {
      const raw = safeGet(identityKey(KEYS.walletBalancePrefix, npub));
      if (!raw) return null;
      try {
        const p = JSON.parse(raw);
        if (
          (p?.rail === 'nwc' || p?.rail === 'spark' || p?.rail === 'webln')
          && typeof p?.balance === 'number' && Number.isFinite(p.balance)
          && typeof p?.ts === 'number'
        ) {
          return p as CachedWalletBalance;
        }
        return null;
      } catch { return null; }
    },
    set: (npub: string | null | undefined, rail: RailPref, balance: number) => {
      safeSet(
        identityKey(KEYS.walletBalancePrefix, npub),
        JSON.stringify({ rail, balance, ts: Date.now() }),
      );
    },
    clear: (npub: string | null | undefined) =>
      safeRemove(identityKey(KEYS.walletBalancePrefix, npub)),
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
   * WHO signs the boost note when sharing is on and the user is signed in:
   * 'self' (default) = their own Nostr key, 'site' = the site's identity
   * (the same server-signed path signed-out boosts use). Signed-out shares
   * always go via the site key regardless of this value.
   */
  shareNostrAs: {
    get: (): ShareNostrAs => (safeGet(KEYS.shareNostrAs) === 'site' ? 'site' : 'self'),
    set: (v: ShareNostrAs) => safeSet(KEYS.shareNostrAs, v),
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
        const arr: unknown = Array.isArray(parsed)
          ? parsed
          : parsed && Array.isArray(parsed.v)
            ? parsed.v
            : null;
        if (!arr) return null;
        // Notes cached before `replies` was added on the type would crash any
        // consumer that iterates `note.replies`. Normalize recursively here.
        const normalize = (n: DiscoveredNote): DiscoveredNote => ({
          ...n,
          replies: Array.isArray(n.replies) ? n.replies.map(normalize) : [],
        });
        return (arr as DiscoveredNote[]).map(normalize);
      } catch {
        return null;
      }
    },
    set: (key: string, v: DiscoveredNote[]) =>
      safeSet(`${KEYS.feedNotesPrefix}:${key}`, JSON.stringify(v)),
  },

  /**
   * Last DiscoveredNote[] per `podcast:socialInteract` URI. Same
   * stale-while-revalidate paint as `feedNotes` (returned regardless of age;
   * every mount of `EpisodeSocialThread` revalidates). Keyed by the raw
   * `nostr:` URI, which is stable per episode. Reuses the recursive `replies`
   * normalizer + legacy `{ t, v }` tolerance so a note cached before any field
   * existed won't crash a consumer iterating `note.replies`.
   */
  socialThread: {
    get: (uri: string): DiscoveredNote[] | null => {
      const raw = safeGet(`${KEYS.socialThreadPrefix}:${uri}`);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        const arr: unknown = Array.isArray(parsed)
          ? parsed
          : parsed && Array.isArray(parsed.v)
            ? parsed.v
            : null;
        if (!arr) return null;
        const normalize = (n: DiscoveredNote): DiscoveredNote => ({
          ...n,
          replies: Array.isArray(n.replies) ? n.replies.map(normalize) : [],
        });
        return (arr as DiscoveredNote[]).map(normalize);
      } catch {
        return null;
      }
    },
    set: (uri: string, v: DiscoveredNote[]) =>
      safeSet(`${KEYS.socialThreadPrefix}:${uri}`, JSON.stringify(v)),
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
        // Re-coerce on read so caches written by older versions of the app
        // (which trusted the kind:0 JSON shape) can't ship a non-string
        // `name` / `display_name` to the UI and crash a `.trim()` call.
        if (cell.v === null) return null;
        return coerceProfileMetadata(cell.v);
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

  /** Per-npub set of "seen"/handled episode keys for the Inbox. Guest uses `:guest`.
   *  Stored as a plain string[] on disk; surfaced as a Set in memory. */
  inboxSeen: {
    get: (npub: string | null | undefined): Set<string> => {
      const raw = safeGet(identityKey(KEYS.inboxSeenPrefix, npub));
      if (!raw) return new Set<string>();
      try {
        const arr = JSON.parse(raw);
        return new Set<string>(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
      } catch {
        return new Set<string>();
      }
    },
    set: (npub: string | null | undefined, v: Set<string>) => {
      safeSet(identityKey(KEYS.inboxSeenPrefix, npub), JSON.stringify([...v]));
    },
  },

  /** Per-npub ordered listen queue ("Up Next"). Persisted so it survives reload.
   *  Entries carry their own podcast (the queue mixes shows). */
  listenQueue: {
    get: (npub: string | null | undefined): { episode: Episode; podcast: Podcast }[] => {
      const raw = safeGet(identityKey(KEYS.listenQueuePrefix, npub));
      if (!raw) return [];
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr)
          ? arr.filter((i) => i && typeof i === 'object' && i.episode && i.podcast)
          : [];
      } catch {
        return [];
      }
    },
    set: (npub: string | null | undefined, v: { episode: Episode; podcast: Podcast }[]) => {
      safeSet(identityKey(KEYS.listenQueuePrefix, npub), JSON.stringify(v));
    },
  },
};
