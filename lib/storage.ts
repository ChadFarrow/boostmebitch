'use client';

// Single source of truth for the `bmb:*` localStorage namespace.
// Every browser-persisted value goes through these typed accessors so the
// raw key strings live in exactly one file and SSR/quota guards aren't
// duplicated across components.

import type { FavoritePodcast, Podcast, StoredBoost } from './types';
import type { DiscoveredNote, MuteListState, ProfileMetadata } from './nostr';
import type { StreamLedger } from './v4v/stream-ledger';
import { coerceProfileMetadata } from './nostr/auth';
import { createObservable } from './pubsub';

// Rail-pref changes need to reach live UI (account-menu summary, balance
// chip, open wallet modal) no matter who wrote them — recordLastRail after
// a boost, the Nostr settings restore in loadProfile, or the wallet modal's
// switch picker. Notifying from the setter is the one choke point that
// covers every writer.
const railPrefObservable = createObservable();
export const subscribeRailPref = railPrefObservable.subscribe;

// Streaming-rate changes reach three live surfaces that don't share a parent:
// the wallet modal's global control, the per-show chip in the episode list, and
// the streaming engine itself (which reads the rate every tick but must react
// immediately when a user turns streaming off mid-listen). Same one-choke-point
// reasoning as railPrefObservable — notify from the setter, not the callers.
const streamRateObservable = createObservable();
export const subscribeStreamRate = streamRateObservable.subscribe;

const KEYS = {
  npub: 'bmb:npub',
  signer: 'bmb:signer',               // 'amber' | 'bunker' | 'local' when a polyfill signer is active; absent = NIP-07 extension or none
  nwcUri: 'bmb:nwc_uri',
  nwcMethods: 'bmb:nwc_methods',      // { uri, methods } — NIP-47 capability list for the CURRENT connection; uri-keyed so a switched wallet invalidates it
  relays: 'bmb:relays',
  senderNamePrefix: 'bmb:sender_name', // + ':<npub>' — the boost modal's "From". Per-npub because it's an identity-linked display name, not a device setting.
  shareNostr: 'bmb:share_nostr',
  shareNostrAs: 'bmb:share_nostr_as', // 'site' when a signed-in user prefers boost notes signed by the site key; absent = own key
  favoritesPrefix: 'bmb:favorites',
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
  sparkOptOutPrefix: 'bmb:spark:opted_out', // + ':<npub>' — set when THAT account explicitly disconnects Spark or replaces a CONNECTED Spark with another rail; suppresses auto-restore on its next login. Never set when Spark wasn't connected (connecting NWC/WebLN on a Spark-less device must not block a later restore). Cleared by every Spark connect path.
  // NOTE: the bare `bmb:spark:opted_out` (no npub suffix) is a DEAD key from
  // the pre-per-npub code. It is deliberately never read or written — see the
  // long note in sparkOptOut.get. It still sits in the localStorage of anyone
  // who used the app before that refactor; leave it there, it is inert.
  theme: 'bmb:theme',                 // 'light' when user chose light mode; absent = dark (default). FOUC-blocker in app/layout.tsx reads this synchronously to set data-theme on <html> before paint.
  streamRate: 'bmb:stream_rate',      // global streaming sats-per-minute; absent = streaming OFF (the default — this spends money unattended, so it must be opted into). Also the prefix for the per-show override `bmb:stream_rate:<podcastGuid|feedId>`, where '0' means "off for THIS show" and outranks the global rate — absent-vs-zero is a real distinction there.
  streamPending: 'bmb:stream_pending', // unsent StreamLedger, so closing the tab mid-accrual doesn't silently discard sats the user already owes
  streamedPrefix: 'bmb:streamed',     // + ':<npub>' — settled-stream log. Deliberately NOT bmb:boosts (see the accessor note).
} as const;

export type RailPref = 'nwc' | 'spark' | 'webln';
export type ShareNostrAs = 'self' | 'site';
export type ThemeMode = 'light' | 'dark';
export interface CachedWalletBalance { rail: RailPref; balance: number; ts: number }

/** One settled streaming payment run — the `bmb:streamed:<npub>` log. */
export interface StreamedEntry {
  ts: number;                  // unix ms
  sats: number;                // total sent in that run
  podcastTitle: string;
  podcastGuid?: string;
  episodeTitle?: string;
  ok: boolean;                 // at least one leg paid
}

export type SignerKind = 'amber' | 'bunker' | 'local';

const BOOSTS_CAP = 200;
const STREAMED_CAP = 100;

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

/**
 * Upper bound on a streaming rate, in sats per minute. A guard rail, not a
 * product limit: the rate is multiplied by elapsed time and paid on a timer
 * with no confirmation, so an implausible stored value has to be treated as
 * corruption. Anyone who wants to send more than this in a minute wants the
 * boost button, which asks first.
 */
const STREAM_RATE_MAX = 10_000;

/** Parse a stored rate, or null when absent/garbage/out of range. */
function saneRate(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > STREAM_RATE_MAX) return null;
  return Math.floor(n);
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
   *  'bunker' = NIP-46 remote signer via the persisted bunker session;
   *  'local' = a key this app holds, kept in IndexedDB under a non-extractable
   *  CryptoKey (see lib/nostr/local-key-store.ts) — NOT in localStorage.
   *  Read on page load to decide which polyfill to install onto window.nostr. */
  signer: {
    get: (): SignerKind | null => {
      const v = safeGet(KEYS.signer);
      if (v === 'amber') return 'amber';
      if (v === 'bunker') return 'bunker';
      if (v === 'local') return 'local';
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
   * The connected wallet's NIP-47 method list, captured at connect time so it
   * survives a reload. Stored WITH the URI it was fetched for: a wallet swap
   * changes the URI, the recorded one no longer matches, and the stale
   * capability is ignored rather than misreported for the new wallet.
   *
   * Read by `nwcGetMethods()`, which is what decides whether a boost to a
   * lightning address may take the keysend path — without persistence that
   * decision would cost a get_info round trip mid-payment on every reload.
   */
  nwcMethods: {
    get: (): { uri: string; methods: string[] } | null => {
      const raw = safeGet(KEYS.nwcMethods);
      if (!raw) return null;
      try {
        const v = JSON.parse(raw);
        if (typeof v?.uri !== 'string' || !Array.isArray(v?.methods)) return null;
        return { uri: v.uri, methods: v.methods.filter((m: unknown) => typeof m === 'string') };
      } catch {
        return null;
      }
    },
    set: (v: { uri: string; methods: string[] }) =>
      safeSet(KEYS.nwcMethods, JSON.stringify(v)),
    clear: () => safeRemove(KEYS.nwcMethods),
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

  /**
   * "This account turned Spark off" — **per-npub**, `:guest` when signed out.
   *
   * This was a single global key, which conflated device with identity: the
   * flag answers a per-account question ("does THIS user want Spark?") but was
   * stored once per browser. Two ways that bit:
   *   - a Google signup for a brand-new key was suppressed by an opt-out some
   *     other identity had made, leaving new users with no wallet at all;
   *   - clearing it on that new account's behalf resurrected Spark for the
   *     identity that had deliberately turned it off.
   *
   * The legacy global value is migrated on first read (below) rather than
   * dropped, so an existing user's deliberate opt-out isn't silently undone by
   * this refactor.
   */
  sparkOptOut: {
    get: (npub: string | null | undefined): boolean => {
      // Tri-state on purpose: '1' = opted out, '0' = explicitly opted IN,
      // absent = no opinion yet.
      //
      // The pre-per-npub GLOBAL `bmb:spark:opted_out` is deliberately NOT read
      // here any more. Inheriting it looked conservative and was the opposite:
      // it recorded that *some* identity on this origin once turned Spark off,
      // under code that couldn't tell identities apart — so applying it to
      // every future npub reproduced the exact device-vs-identity conflation
      // the per-npub split exists to end.
      //
      // It cost a real user their wallet. A production origin still carried a
      // stale global '1' from the old code; a returning Google account had no
      // scoped entry, inherited the '1', and deriveSparkFromLocalKey refused to
      // bring the wallet up — silently, with no way for them to know why.
      //
      // The two failure directions are not symmetric, and that's the whole
      // argument. Wrongly restoring a wallet is visible and self-correcting:
      // the user disconnects, which writes a proper per-npub '1'. Wrongly
      // withholding one is invisible and permanent. This flag only suppresses
      // an auto-restore — it guards no funds and no privacy — so the mild,
      // recoverable direction is the right one to fail in.
      const scoped = safeGet(identityKey(KEYS.sparkOptOutPrefix, npub));
      return scoped === '1';
    },
    set: (npub: string | null | undefined) =>
      safeSet(identityKey(KEYS.sparkOptOutPrefix, npub), '1'),
    /** Records an explicit "this account wants Spark" — see the tri-state note. */
    clear: (npub: string | null | undefined) =>
      safeSet(identityKey(KEYS.sparkOptOutPrefix, npub), '0'),
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

  /**
   * The boost modal's "From" name, per-npub (`:guest` signed out).
   *
   * It was one global key, and that leaked a real name across identities: a
   * user who had boosted as themselves, then signed in with a Google-onboarded
   * account, got their old name pre-filled in the "From" box — and it outranks
   * the profile name in the modal's fallback chain, so it would have shipped in
   * the boostagram's `sender_name`. That ties a generated npub straight back to
   * the identity it was designed not to be linked to.
   *
   * **Deliberately no migration from the old global key**, unlike sparkOptOut's
   * legacy fallback. There's no way to know which identity that name belonged
   * to, so adopting it into whichever npub reads first would recreate exactly
   * the leak this fixes. The name is one field and costs nothing to retype; the
   * orphaned key is a few harmless bytes.
   */
  senderName: {
    get: (npub: string | null | undefined) => safeGet(identityKey(KEYS.senderNamePrefix, npub)),
    set: (npub: string | null | undefined, v: string) =>
      safeSet(identityKey(KEYS.senderNamePrefix, npub), v),
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

  /**
   * Streaming sats-per-minute. Two scopes, resolved by `resolveStreamRate`
   * in lib/v4v/streaming.ts: a per-show override wins over the global rate.
   *
   * **Absent and `0` are different states, and the difference is load-bearing.**
   * Absent at show scope means "no opinion — follow the global rate"; `0` means
   * "off for this show" and must survive the global rate being raised later.
   * Hence `get` is tri-state (`number | null`) rather than defaulting to 0.
   *
   * Both scopes read through `sane()`: this number is multiplied by elapsed
   * time and paid without a confirmation step, so a corrupted key (another
   * tab, a hand-edited devtools value, a half-written string) must degrade to
   * "streaming off" rather than to an unbounded spend. The cap is deliberately
   * low — anyone wanting to move more than that per minute wants a boost.
   */
  streamRate: {
    /** Global default. null = streaming off (the default for a new install). */
    get: (): number | null => saneRate(safeGet(KEYS.streamRate)),
    set: (satsPerMin: number) => {
      if (satsPerMin > 0) safeSet(KEYS.streamRate, String(Math.floor(satsPerMin)));
      else safeRemove(KEYS.streamRate);
      streamRateObservable.notify();
    },
    /** Per-show override. null = no override; 0 = explicitly off for this show. */
    getShow: (showKey: string): number | null =>
      showKey ? saneRate(safeGet(`${KEYS.streamRate}:${showKey}`)) : null,
    setShow: (showKey: string, satsPerMin: number | null) => {
      if (!showKey) return;
      const key = `${KEYS.streamRate}:${showKey}`;
      if (satsPerMin === null) safeRemove(key);
      else safeSet(key, String(Math.max(0, Math.floor(satsPerMin))));
      streamRateObservable.notify();
    },
  },

  /**
   * The unsent accrual, mirrored to disk every tick.
   *
   * Without it, closing the tab nine minutes into a ten-minute settle window
   * silently discards sats the listener already earned the host — invisible to
   * both sides. The engine restores this on the next play of the same item and
   * either settles or keeps accruing. Reads reject a ledger that isn't
   * structurally intact: this value is turned into a payment, so a half-written
   * or foreign-shaped record must read as "nothing pending", never as a partial
   * ledger with a plausible-looking balance.
   */
  streamPending: {
    get: (): StreamLedger | null => {
      const raw = safeGet(KEYS.streamPending);
      if (!raw) return null;
      try {
        const v = JSON.parse(raw);
        if (!v || typeof v !== 'object') return null;
        const nums = ['lastTickMs', 'lastPositionSec', 'lastSettleMs'] as const;
        if (typeof v.key !== 'string' || !v.key) return null;
        if (nums.some((f) => typeof v[f] !== 'number' || !Number.isFinite(v[f]))) return null;
        if (!v.buckets || typeof v.buckets !== 'object' || Array.isArray(v.buckets)) return null;
        // Every balance is validated, not just the shape: each one becomes a
        // payment amount, and a single NaN or negative entry would either
        // poison the total or read as a credit.
        const buckets: Record<string, number> = {};
        for (const [bucket, msat] of Object.entries(v.buckets)) {
          if (typeof msat !== 'number' || !Number.isFinite(msat) || msat < 0) return null;
          buckets[bucket] = msat;
        }
        return { ...v, buckets } as StreamLedger;
      } catch {
        return null;
      }
    },
    set: (v: StreamLedger) => safeSet(KEYS.streamPending, JSON.stringify(v)),
    clear: () => safeRemove(KEYS.streamPending),
  },

  /**
   * Settled streaming runs, per npub — the user's "what did streaming cost me"
   * record, newest first.
   *
   * **Separate from `boosts` on purpose.** That log is capped at 200 AND is
   * rendered into the global Nostr feed as the user's own sends; six settlements
   * an hour would both evict real boosts within a day and bury the feed under
   * ambient background payments nobody chose to publish.
   */
  streamed: {
    get: (npub: string | null | undefined): StreamedEntry[] => {
      const raw = safeGet(identityKey(KEYS.streamedPrefix, npub));
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as StreamedEntry[]) : [];
      } catch {
        return [];
      }
    },
    add: (npub: string | null | undefined, entry: StreamedEntry) => {
      const list = storage.streamed.get(npub);
      safeSet(
        identityKey(KEYS.streamedPrefix, npub),
        JSON.stringify([entry, ...list].slice(0, STREAMED_CAP)),
      );
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
