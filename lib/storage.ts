'use client';

// Single source of truth for the `bmb:*` localStorage namespace.
// Every browser-persisted value goes through these typed accessors so the
// raw key strings live in exactly one file and SSR/quota guards aren't
// duplicated across components.

import type { Episode, FavoriteEpisode, FavoritePodcast, Podcast, StoredBoost } from './types';
import type { DiscoveredNote, FavoritesBaseline, FavoritesPrivacy, MuteListState, ProfileMetadata } from './nostr';
// Value import, so it must come from the import-free leaf rather than the
// './nostr' barrel: the barrel pulls in relays.ts, which imports this module,
// and unlike the type-only line above a value import does NOT erase.
import { emptyMuteState, type MuteCipher } from './nostr/mute-state';
import type { StreamLedger } from './v4v/stream-ledger';
import {
  DEFAULT_STREAM_AMOUNT_PER_TRACK,
  DEFAULT_STREAM_RATE_PER_MIN,
  STREAM_AMOUNT_MAX_SATS,
  STREAM_RATE_MAX_PER_MIN,
} from './v4v/stream-ledger';
import { coerceProfileMetadata } from './nostr/profile-metadata';
import { createObservable } from './pubsub';

// Rail-pref changes need to reach live UI (account-menu summary, balance
// chip, open wallet modal) no matter who wrote them — recordLastRail after
// a boost, the Nostr settings restore in loadProfile, or the wallet modal's
// switch picker. Notifying from the setter is the one choke point that
// covers every writer.
const railPrefObservable = createObservable();
export const subscribeRailPref = railPrefObservable.subscribe;

/**
 * Where this account's favorites go changed.
 *
 * Two surfaces render it — the /favorites control and the first-favorite
 * prompt — and a third (the sync notice) changes its wording by it, so a write
 * has to reach all of them. Without this the control the user just pressed
 * shows the old value until something else re-renders the page, which reads as
 * a control that does not work.
 */
const favPrivacyObservable = createObservable();
export const subscribeFavPrivacy = favPrivacyObservable.subscribe;

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
  streamReceipts: 'bmb:stream_receipts', // '1' when the listener opted into publishing kind:3369 value-playback receipts for streaming settles. Absent = OFF, unlike shareNostr — see the accessor.
  streamSummaries: 'bmb:stream_summaries', // '1' when the listener also opted into kind:33369 running totals. Absent = OFF. Requires streamReceipts — a summary is derived FROM receipts.
  favCollapsed: 'bmb:fav_collapsed',  // string[] of COLLAPSED favorites group headings ('show:<medium>' / 'ep:<medium>'). A device SETTING, not a cache — deliberately absent from EVICTABLE_PREFIXES.
  sectionCollapsed: 'bmb:sect_collapsed', // string[] of COLLAPSED <FeedSection> keys ('npub:sent' / 'npub:recv'). Same sense and same reasoning as favCollapsed below — a section this device has never seen must default to VISIBLE. A device SETTING, not a cache: deliberately absent from EVICTABLE_PREFIXES.
  favView: 'bmb:fav_view',            // JSON {tab,sort,split} — the /favorites control row. A device SETTING, not a cache: deliberately absent from EVICTABLE_PREFIXES. (Replaced 'bmb:fav_panel_open', which described a home-page panel that no longer exists; stale values there are inert.)
  favoritesPrefix: 'bmb:favorites',
  favoriteEpisodesPrefix: 'bmb:favepisodes', // + ':<npub>' — favorited episodes, keyed by item guid
  favClearedPrefix: 'bmb:fav_cleared', // + ':<npub>' — '1' while this device is DELIBERATELY holding no favorites. The one thing that tells "the user unfavorited everything" from "the store has not hydrated yet", which are otherwise the same bytes: an empty store beside a baseline that claims ids. Set only by a removal that empties the list; cleared by any add and by the publish that carries the removal.
  favPrivacyPrefix: 'bmb:fav_privacy', // + ':<npub>' — 'public' | 'private' | 'off'. WHERE this account's favorites go, not a cache: absent means "never chosen", which is a third state the hydrator seeds from the wire and the first-favorite prompt asks about. Deliberately absent from EVICTABLE_PREFIXES — evicting it would silently republish a private list in plaintext.
  favPrivateOptIn: 'bmb:fav_private_optin', // device-wide '1' — the escape hatch for testing the private half before PRIVATE_FAVORITES_ENABLED goes true. Not per-npub: it is a build switch a human flips on their own machine, not a user preference.
  favBaselinePrefix: 'bmb:favbaseline', // + ':<npub>' — {feeds,items} of NIP-73 ids this device last agreed with the kind:10333 list on. NOT a cache: without it a shared, replaceable, many-writer event can't tell "another app added this" from "I removed this". See lib/nostr/favorites-list.ts.
  podcastMetaPrefix: 'bmb:pmeta',     // /api/by-guid result, keyed by guid
  episodeMetaPrefix: 'bmb:epmeta',    // /api/episode-by-guid result, keyed by '<feedGuid>:<itemGuid>'
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
  writeRelaysPrefix: 'bmb:wrelays',   // + ':<npub>' — that account's NIP-65 (kind:10002) WRITE relays, cached so the next load can read the shared lists from the same relays it publishes them to. NOT evictable: losing it re-opens the read-narrower-than-write window, see lib/nostr/relays.ts.
  sparkOptOutPrefix: 'bmb:spark:opted_out', // + ':<npub>' — set when THAT account explicitly disconnects Spark or replaces a CONNECTED Spark with another rail; suppresses auto-restore on its next login. Never set when Spark wasn't connected (connecting NWC/WebLN on a Spark-less device must not block a later restore). Cleared by every Spark connect path.
  // NOTE: the bare `bmb:spark:opted_out` (no npub suffix) is a DEAD key from
  // the pre-per-npub code. It is deliberately never read or written — see the
  // long note in sparkOptOut.get. It still sits in the localStorage of anyone
  // who used the app before that refactor; leave it there, it is inert.
  // Amber's NIP-55 callback round trip. localStorage, NOT sessionStorage, and
  // that is a measurement rather than a preference: Brave opens Amber's callback
  // in a NEW TAB (Pixel 6, real https origin, tab count 15 -> 16), and
  // sessionStorage is per-tab, so a tab-scoped record is never there when the
  // callback lands. Neither key may ever hold a secret — see the accessors and
  // AMBER_PERSISTABLE_TYPES.
  amberPending: 'bmb:amber_pending',  // the NIP-55 request we dispatched and are waiting on: a random request id, the method, a timestamp, and the route to return to. No payload, no key material.
  amberResult: 'bmb:amber_result',    // the result Amber handed back, parked until the caller re-asks. ONLY ever a get_public_key result, i.e. a PUBLIC key — a decrypt result is a plaintext and is refused rather than written here.
  theme: 'bmb:theme',                 // 'light' when user chose light mode; absent = dark (default). FOUC-blocker in app/layout.tsx reads this synchronously to set data-theme on <html> before paint.
  // ── sessionStorage, NOT localStorage ──────────────────────────────────────
  // Both die with the tab, which is exactly why they're allowed to hold what
  // they hold. Accessed via storage.nwcSessionUri / storage.piBreaker at the
  // foot of this file, never through safeGet/safeSet — those are localStorage
  // and their memory mirror would outlive the tab lifetime that makes these
  // safe.
  nwcUriSessPrefix: 'bmb:nwc_uri_sess', // + ':<npub>' — NWC URI parked across a same-account sign-out → sign-in in one tab. A SPENDING CREDENTIAL; tab-scoped on purpose.
  piDead: 'bmb:pi:dead',              // '1' while the Podcast Index breaker is tripped. Survives a reload (an outage doesn't end because someone refreshed), not the tab.
  // Streaming rate and streaming on/off are SEPARATE keys, at both scopes, so
  // switching streaming off doesn't destroy the number the user typed. Also the
  // prefixes for the per-show overrides `…:<podcastGuid|feedId>`.
  streamRate: 'bmb:stream_rate',      // remembered sats-per-minute — a positive number or absent; never 0, and never removed by the toggle
  streamMode: 'bmb:stream_mode',      // 'track' when the unit picker is on "per track"; absent/'rate' = per minute. Show-scope entry overrides the global one, same precedence as the rate.
  streamAmount: 'bmb:stream_amount',  // remembered sats-per-TRACK, kept separate from streamRate so flipping the unit never destroys the other number
  epOrder: 'bmb:ep_order',            // per-SHOW episode order: 'oldest' when the user flipped that show to oldest-first; absent = newest-first (the feed's own order). A device SETTING, not a cache — deliberately absent from EVICTABLE_PREFIXES.
  streamOn: 'bmb:stream_on',          // '1' on | '0' off | absent = no opinion. Absent at global scope means OFF (streaming is opt-in); absent at show scope means "follow the global rate", while an explicit '0' means "never stream this show" and outranks a global rate raised later.
  streamPending: 'bmb:stream_pending', // unsent StreamLedger, so closing the tab mid-accrual doesn't silently discard sats the user already owes
  streamedPrefix: 'bmb:streamed',     // + ':<npub>' — settled-stream log. Deliberately NOT bmb:boosts (see the accessor note).
} as const;

/** An Amber request we dispatched and are waiting on across a page load.
 *  Deliberately carries no payload and no secret — just enough to recognise
 *  the answer when it navigates back. */
export interface AmberPending {
  /** 32 lowercase hex, from `newAmberRequestId()`. */
  rid: string;
  /** The NIP-55 method, so the result can be shape-checked for the right thing. */
  type: 'get_public_key' | 'sign_event' | 'nip04_encrypt' | 'nip04_decrypt' | 'nip44_encrypt' | 'nip44_decrypt';
  /** `Date.now()` at dispatch. Used for the pending TTL, which is deliberately
   *  longer than the in-memory promise timeout: the promise giving up is not
   *  the same event as the request becoming unmatchable. */
  ts: number;
  /** Where the user was, so the callback can send them back rather than to `/`. */
  origin?: string;
}

/**
 * Which Amber results may be written to disk at all.
 *
 * `bmb:amber_result` is localStorage (see the accessor for why), so this is the
 * line between "a public key waiting to be picked up" and "the user's decrypted
 * private data sitting in a browser profile". `get_public_key` returns a PUBLIC
 * key and is safe. `nip04_decrypt` / `nip44_decrypt` return plaintext and are
 * not; `sign_event` returns an event the user may not have published yet.
 *
 * Adding a type here is a security decision, not a feature flag. It is also NOT
 * the same list as `RESUMABLE_TYPES` in lib/nostr/amber.ts, which answers a
 * different question — whether a request can afford a page reload. A type must
 * satisfy BOTH to round-trip through a callback.
 */
export const AMBER_PERSISTABLE_TYPES: ReadonlySet<string> = new Set(['get_public_key']);

/** A result Amber handed back, parked until the caller re-issues its request. */
export interface AmberParkedResult {
  rid: string;
  type: AmberPending['type'];
  /** The raw string Amber returned. NOT validated here. */
  value: string;
  ts: number;
}

export type RailPref = 'nwc' | 'spark' | 'webln';
/** What the streaming number means: sats per minute, or sats per track. */
export type StreamMode = 'rate' | 'track';
export type ShareNostrAs = 'self' | 'site';
export type ThemeMode = 'light' | 'dark';
export interface CachedWalletBalance {
  rail: RailPref;
  /** What that rail could SEND when it was read — on NWC, budget-capped. */
  balance: number;
  ts: number;
  /**
   * True when a per-connection NWC budget capped that number. Carried so the
   * cached paint on page load keeps the caveat the live read would print; an
   * older record without the field reads as `false`, which only costs the
   * caveat for the second it takes the first read to land.
   */
  limited?: boolean;
}

/** One settled streaming payment run — the `bmb:streamed:<npub>` log. */
export interface StreamedEntry {
  /** Unix MILLIseconds — note `timeAgo` in lib/format.tsx takes SECONDS. */
  ts: number;
  sats: number;                // total sent in that run; 0 on a failure entry
  podcastTitle: string;
  podcastGuid?: string;
  episodeTitle?: string;
  ok: boolean;                 // at least one leg paid
  /** Why it failed, on `ok: false` entries. Written once per item when
   *  streaming gives up, never once per attempt — otherwise a dead wallet
   *  would fill the capped log with the same line. */
  error?: string;
}

export type SignerKind = 'amber' | 'bunker' | 'local';

/**
 * The `/favorites` control row. `tab` is a `groupByMedium` bucket key — a
 * lowercased `<podcast:medium>`, or `'~unknown'`, or `'all'` — and is a plain
 * string on purpose: the medium vocabulary is open, so a closed union here
 * would reject exactly the media a newer app introduces.
 */
export interface FavView {
  tab: string;
  sort: 'recent' | 'az';
  split: 'all' | 'feeds' | 'items';
}

/**
 * `recent` rather than `az`, because "what did I just save" is the question a
 * library page gets asked. It also puts the unresolved placeholders last —
 * `addedAt: 0` means "not known yet" — which is where they belong.
 */
const DEFAULT_FAV_VIEW: FavView = { tab: 'all', sort: 'recent', split: 'all' };

const BOOSTS_CAP = 200;
const STREAMED_CAP = 100;

const isBrowser = () => typeof window !== 'undefined';

/**
 * Values whose localStorage write did NOT land, kept for the rest of the
 * session so the control the user just touched still works.
 *
 * A swallowed write is worse than a visible failure: every setting in this file
 * is read straight back out of storage, so a UI with no local state of its own
 * (`<StreamRate>` is exactly that) renders the OLD value and the control looks
 * broken — tap it, nothing happens, no error anywhere. That is precisely how
 * "I can't turn on streaming sats on iOS Safari" presents.
 *
 * Two causes, both real and both silent: a hostile localStorage (Private
 * Browsing, "Block All Cookies", content blockers) where `setItem` throws
 * SecurityError, and a FULL one — iOS Safari's per-origin quota is the
 * tightest in the wild, and this app caches whole nostr events, so a
 * long-lived install fills it and then every write throws QuotaExceededError,
 * down to a one-byte `bmb:stream_on`. Reads keep working, so nothing else on
 * screen looks wrong.
 *
 * Lost on reload — persistence is the user's to fix, and callers surface that
 * via the `isEphemeral` accessors — but the session is honest either way.
 * Caches are deliberately NOT mirrored here: they exist to save a refetch, and
 * holding a megabyte of notes in a Map to work around storage pressure just
 * moves the problem.
 */
const memoryMirror = new Map<string, string>();

/**
 * Namespaces that may be thrown away to make room for a write that matters,
 * ordered biggest-payoff-first. Every one is a network-regenerable cache: no
 * user setting, no identity, no credential, nothing that can't be refetched.
 *
 * The two note caches come first because they hold whole nostr events (~1 KB
 * apiece, unbounded per feed surface and per socialInteract URI) and account
 * for nearly all of the bytes; the profile and by-guid caches are small but
 * numerous and cost a visible refetch, so they go last.
 */
const EVICTABLE_PREFIXES = [
  KEYS.socialThreadPrefix,
  KEYS.feedNotesPrefix,
  KEYS.profilePrefix,
  KEYS.podcastMetaPrefix,
  KEYS.episodeMetaPrefix,
] as const;

const isEvictableKey = (key: string) =>
  EVICTABLE_PREFIXES.some((p) => key.startsWith(`${p}:`));

function rawKeys(): string[] {
  try { return Object.keys(localStorage); } catch { return []; }
}

/** Drop one cache namespace. Returns false when it held nothing to drop. */
function evictNamespace(prefix: string): boolean {
  const doomed = rawKeys().filter((k) => k.startsWith(`${prefix}:`));
  if (doomed.length === 0) return false;
  for (const k of doomed) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
  return true;
}

function writeThrough(key: string, value: string): boolean {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

function safeGet(key: string): string | null {
  if (!isBrowser()) return null;
  let v: string | null = null;
  try { v = localStorage.getItem(key); } catch { /* blocked — fall through */ }
  return v ?? memoryMirror.get(key) ?? null;
}

/**
 * Returns whether the value actually reached disk.
 *
 * On a full store this evicts caches and retries, one namespace at a time so a
 * single failed setting doesn't wipe every cache the app has: **a cache never
 * displaces a setting, and a setting always displaces a cache.** A failing
 * write of an evictable key is therefore left to fail — dropping other caches
 * to fit one more cache is thrash, and the cost of skipping it is a refetch.
 */
function safeSet(key: string, value: string): boolean {
  if (!isBrowser()) return false;
  if (writeThrough(key, value)) {
    memoryMirror.delete(key);
    return true;
  }
  if (!isEvictableKey(key)) {
    for (const prefix of EVICTABLE_PREFIXES) {
      if (!evictNamespace(prefix)) continue;
      if (writeThrough(key, value)) {
        memoryMirror.delete(key);
        return true;
      }
    }
    // Storage is blocked outright, or too full for even a few bytes. Hold the
    // value for this session rather than discarding what the user just chose.
    memoryMirror.set(key, value);
  }
  return false;
}

function safeRemove(key: string) {
  // Mirror first: a removal that only cleared disk would let the in-memory
  // copy resurrect the value on the next read — a disconnected wallet or a
  // cleared override coming back to life.
  memoryMirror.delete(key);
  if (!isBrowser()) return;
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

function safeKeys(): string[] {
  if (!isBrowser()) return [];
  // Union with the mirror, or a setting held only in memory would be invisible
  // to the key scans that count them (`showsExplicitlyOn`).
  return [...new Set([...rawKeys(), ...memoryMirror.keys()])];
}

/** True when `key`'s current value is only held in memory — i.e. its write
 *  didn't persist and a reload will lose it. Backs the soft hints that tell
 *  the user their setting won't survive, instead of letting them find out. */
const isMemoryOnly = (key: string) => memoryMirror.has(key);

// Per-identity storage keys: signed-out users share a single `:guest` bucket;
// signed-in users get one bucket per npub. Centralized so the convention
// lives in exactly one place.
function identityKey(prefix: string, npub: string | null | undefined) {
  return `${prefix}:${npub ?? 'guest'}`;
}

/**
 * Parse a stored streaming rate, or null when absent/garbage/out of range.
 *
 * A rate is always a POSITIVE number here: "off" is the separate `bmb:stream_on`
 * flag's job, never a zero in this field. That separation is what lets the
 * toggle turn streaming off without destroying the number the user typed.
 *
 * The bound and the reject-to-null are the point: this value is multiplied by
 * elapsed time and paid on a timer with no confirmation step, so a corrupt key
 * (another tab, a hand-edited devtools value, a half-written string) must
 * degrade to "off" rather than to an unbounded spend.
 */
function saneRate(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > STREAM_RATE_MAX_PER_MIN) return null;
  return Math.floor(n);
}

/** `saneRate` for the per-track amount — same corrupt-reads-as-absent rule. */
function saneAmount(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > STREAM_AMOUNT_MAX_SATS) return null;
  return Math.floor(n);
}

/** Anything that isn't an explicit `'track'` reads as per-minute — the mode that
 *  existed before this key, so an absent or corrupt value keeps old behaviour. */
function readMode(key: string): StreamMode | null {
  const raw = safeGet(key);
  if (raw === null) return null;
  return raw === 'track' ? 'track' : 'rate';
}

/** Read an on/off flag: true, false, or null for "no opinion recorded". */
function readOn(key: string): boolean | null {
  const v = safeGet(key);
  if (v === '1') return true;
  if (v === '0') return false;
  return null;
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
//
// `emptyMuteState` itself is imported from the import-free leaf rather than
// redefined: it used to be a private copy here, identical to the one in
// lib/nostr/mutes.ts, and two constructors for one persisted shape is how a
// field added on one side goes missing on the other. Importing it from
// ./nostr/mutes instead would close a storage → mutes → relays → storage cycle,
// which is why the leaf exists.
function coerceToMuteState(parsed: unknown): MuteListState {
  if (!parsed || typeof parsed !== 'object') return emptyMuteState();
  const p = parsed as Record<string, unknown>;
  const stringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const tagArray = (v: unknown): string[][] =>
    Array.isArray(v) ? v.filter((x): x is string[] => Array.isArray(x)) : [];
  const ts = typeof p.updatedAt === 'number' ? p.updatedAt : 0;
  // Validated against the literals rather than passed through: a persisted
  // value this build does not understand must not reach `publishMuteList`,
  // which chooses an encryption cipher from it.
  const cipher = (v: unknown): MuteCipher | undefined =>
    v === 'plaintext' || v === 'nip04' || v === 'nip44' || v === 'unknown' ? v : undefined;

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
    // SAME RULE, AND THIS FIELD IS THE REASON THE RULE EXISTS TWICE. Dropping it
    // here does not lose a mute — it makes every cold start on an out-of-browser
    // signer fail to recognize a private half this device already opened, park
    // it again, and tell the user it stayed shut. Which is exactly the bug the
    // field was added to fix, reintroduced by an omission rather than by a
    // change of behaviour.
    knownPrivateContent:
      typeof p.knownPrivateContent === 'string' ? p.knownPrivateContent : undefined,
    // READ THIS BACK, or the field dies on every reload. This function rebuilds
    // the state field by field, so one it does not name is dropped silently —
    // and the symptom is not a missing field, it is `publishMuteList` seeing no
    // observed cipher and rewriting a NIP-44 list as NIP-04 the next time a
    // local mute fires `schedulePublishMuteList`. Unreadable to the client that
    // wrote it, with nothing on screen saying so.
    privateCipher: cipher(p.privateCipher),
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
    // The memory-mirror fallback that used to live here by hand is now in
    // `safeSet`/`safeGet` for every key: a URI "saved" to nowhere bounced the
    // wallet modal back to the connect form with no recovery path, and the
    // same swallowed write breaks every other setting the same way.
    get: () => safeGet(KEYS.nwcUri),
    set: (v: string) => { safeSet(KEYS.nwcUri, v); },
    clear: () => safeRemove(KEYS.nwcUri),
    has: () => safeGet(KEYS.nwcUri) !== null,
    /** True if the URI is only held in memory — i.e. the localStorage write
     *  failed and the user will lose it on reload. Used to show a soft
     *  "won't persist across reloads" hint. */
    isEphemeral: () => isMemoryOnly(KEYS.nwcUri),
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

  /**
   * That account's NIP-65 kind:10002 WRITE relays, from the last load that
   * resolved them.
   *
   * This is a routing hint, not content, and it exists because the read and the
   * write of every shared list must target the SAME relay set. `loadProfile`
   * fetches kind:10002 in parallel with the favorites and mute-list hydrations,
   * so on a cold load those two ran against `DEFAULT_RELAYS` alone while every
   * publish went to `resolvePublishRelays` — the user's write relays UNIONED
   * with the defaults. A read narrower than its write is how you overwrite data
   * you never saw, and on a device with no local cache it renders as the list
   * simply not being there. Caching the set is what lets the next load start
   * wide instead of paying a second relay round trip for it.
   *
   * Deliberately absent from `EVICTABLE_PREFIXES`. It is a few hundred bytes,
   * and the cost of dropping it is not a refetch — it is one cold load reading
   * the narrow set again. Same reasoning as `favBaselinePrefix` and
   * `followsPrefix`, which are also small, also regenerable in principle, and
   * also load-bearing for a write decision.
   *
   * Never written from an empty result: "this account has no kind:10002" and
   * "nothing answered" are the same `null` out of `fetchRelayList`, and
   * adopting the second would wipe a good hint on one bad query.
   */
  writeRelays: {
    get: (npub: string | null | undefined): string[] => {
      const raw = safeGet(identityKey(KEYS.writeRelaysPrefix, npub));
      if (!raw) return [];
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? (arr as string[]).filter((r) => typeof r === 'string') : [];
      } catch { return []; }
    },
    /** No-op for an empty list — see the note above. */
    set: (npub: string | null | undefined, relays: string[]) => {
      if (!relays.length) return false;
      return safeSet(identityKey(KEYS.writeRelaysPrefix, npub), JSON.stringify(relays));
    },
    clear: (npub: string | null | undefined) =>
      safeRemove(identityKey(KEYS.writeRelaysPrefix, npub)),
  },

  /**
   * Which way round one show's episode list runs.
   *
   * PER SHOW, keyed by `showStorageKey(podcast)` — the same key the per-show
   * streaming override uses. The reason to read a feed oldest-first belongs to
   * the show, not the person: a serialized drama or a course wants it and a
   * daily news show does not, so one global flip would be wrong for most of a
   * library the moment it is right for one show.
   *
   * **Absent means newest-first, and flipping back REMOVES the key** rather
   * than writing `'newest'`, so there is exactly one sentinel for the default —
   * the `theme` idiom below. That also keeps the cost of the per-show scheme
   * honest: keys only accumulate for shows somebody deliberately reversed.
   * Nothing prunes them, which is accepted here for the reason `bmb:stream_*`
   * accepts it — a few bytes each, and losing one silently would change what a
   * list says.
   *
   * A SETTING, not a cache: it is not in `EVICTABLE_PREFIXES`, so a full store
   * evicts note blobs before it touches this.
   */
  episodeOrder: {
    getShow: (showKey: string): 'oldest' | null =>
      (showKey && safeGet(`${KEYS.epOrder}:${showKey}`) === 'oldest' ? 'oldest' : null),
    setShow: (showKey: string, oldestFirst: boolean) => {
      if (!showKey) return;
      const key = `${KEYS.epOrder}:${showKey}`;
      if (oldestFirst) safeSet(key, 'oldest');
      else safeRemove(key);
    },
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
   *
   * `balance` is the SPENDABLE number, which on NWC is capped by the
   * connection's budget — `limited` records that it was, so the cached paint
   * carries the same caveat the live read does.
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
          return { ...p, limited: p?.limited === true } as CachedWalletBalance;
        }
        return null;
      } catch { return null; }
    },
    set: (
      npub: string | null | undefined,
      rail: RailPref,
      balance: number,
      limited = false,
    ) => {
      safeSet(
        identityKey(KEYS.walletBalancePrefix, npub),
        JSON.stringify({ rail, balance, ts: Date.now(), limited }),
      );
    },
    clear: (npub: string | null | undefined) =>
      safeRemove(identityKey(KEYS.walletBalancePrefix, npub)),
  },

  /**
   * Which <FeedSection> headings the user has collapsed.
   *
   * COLLAPSED keys are stored, never expanded ones — the same rule, and the
   * same reason, as `favCollapsed` below: a section this device has never seen
   * must default to VISIBLE. Storing expanded keys would fold away every
   * section added later, behind a heading the user never touched.
   *
   * Keys are caller-chosen and namespaced by surface ('npub:sent',
   * 'npub:recv'), so two surfaces adding a "received" section don't collapse
   * each other's. Stale keys are harmless and left alone.
   */
  sectionCollapsed: {
    get: (): string[] => {
      const raw = safeGet(KEYS.sectionCollapsed);
      if (!raw) return [];
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter((k): k is string => typeof k === 'string') : [];
      } catch {
        return [];
      }
    },
    /** Empty set removes the key rather than storing '[]' — nothing collapsed is the default. */
    set: (v: string[]) =>
      (v.length ? safeSet(KEYS.sectionCollapsed, JSON.stringify(v)) : safeRemove(KEYS.sectionCollapsed)),
  },

  /**
   * Which favorites group headings the user has collapsed.
   *
   * COLLAPSED keys are stored, never expanded ones, and the distinction is
   * load-bearing: the medium vocabulary is open (see `groupByMedium`), so a
   * medium this device has never grouped by must default to VISIBLE. Storing
   * expanded keys would hide every future group behind a heading the user
   * never touched, and hiding a favorite is the one failure this control must
   * not have.
   *
   * Keys are namespaced by list — 'show:<medium>' and 'ep:<medium>' — because
   * both lists group by medium and 'music' appears in each. One shared key
   * would collapse a user's albums the moment they collapsed their tracks.
   *
   * Stale keys (a medium the user no longer has anything under) are harmless
   * and left alone: the set is bounded by the medium vocabulary, and pruning
   * on write would mean a device that momentarily resolved nothing — a PI
   * outage, mid-hydration — silently forgetting the user's choice.
   */
  favCollapsed: {
    get: (): string[] => {
      const raw = safeGet(KEYS.favCollapsed);
      if (!raw) return [];
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter((k): k is string => typeof k === 'string') : [];
      } catch {
        return [];
      }
    },
    /** Empty set removes the key rather than storing '[]' — nothing collapsed is the default. */
    set: (v: string[]) => (v.length ? safeSet(KEYS.favCollapsed, JSON.stringify(v)) : safeRemove(KEYS.favCollapsed)),
  },

  /**
   * How the user last left the `/favorites` controls: medium tab, sort order,
   * and which half of the library is on screen.
   *
   * One key rather than three, because the three are read together on every
   * render of that page and written together by one handler — three keys would
   * be three `safeSet` calls that can independently fail on a full store,
   * leaving a control row in a state the user never chose.
   *
   * **Every field falls back on its own.** A value from a newer build (a tab
   * naming a medium this build doesn't render, a sort we dropped) must not
   * take the other two down with it, so each is validated separately and a bad
   * one resolves to the default rather than discarding the object. The tab is
   * deliberately NOT validated against the medium vocabulary here — that
   * vocabulary is open and lives in `groupByMedium`; the page falls through to
   * `all` when the tab names a medium the user no longer has anything under.
   *
   * A device view setting, not per-npub, and not evictable — a cache may never
   * displace a setting.
   */
  favView: {
    get: (): FavView => {
      const raw = safeGet(KEYS.favView);
      if (!raw) return { ...DEFAULT_FAV_VIEW };
      try {
        const v = JSON.parse(raw);
        return {
          tab: typeof v?.tab === 'string' ? v.tab : DEFAULT_FAV_VIEW.tab,
          sort: v?.sort === 'az' || v?.sort === 'recent' ? v.sort : DEFAULT_FAV_VIEW.sort,
          split:
            v?.split === 'feeds' || v?.split === 'items' || v?.split === 'all'
              ? v.split
              : DEFAULT_FAV_VIEW.split,
        };
      } catch {
        return { ...DEFAULT_FAV_VIEW };
      }
    },
    set: (v: FavView) => safeSet(KEYS.favView, JSON.stringify(v)),
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
   * Whether a streaming settle publishes a kind:3369 value-playback receipt.
   *
   * **Unset = OFF, which is the opposite of `shareNostr` above, and the
   * asymmetry is the point.** That one governs one note per button press,
   * describing a payment the user just chose to make. This one governs a
   * continuous, public, timestamped record of what was played and when — a
   * disclosure nobody consented to by ticking "post my boosts". Defaulting it
   * on, or folding it into `shareNostr`, would borrow that consent for
   * something materially larger.
   *
   * `set` returns whether the write reached disk. A settings control here has no
   * local state and renders whatever reads back, so a dropped write freezes the
   * switch with no error anywhere — see the safeSet notes in CLAUDE.md.
   */
  streamReceipts: {
    get: (): boolean => safeGet(KEYS.streamReceipts) === '1',
    set: (v: boolean): boolean => safeSet(KEYS.streamReceipts, v ? '1' : '0'),
  },

  /**
   * Whether a finished listen also publishes a kind:33369 running total.
   *
   * **A separate key from `streamReceipts`, and off by default even when
   * receipts are on.** The two are not the same disclosure. A receipt is one
   * event among hundreds, findable only by someone who already queries this
   * pubkey. A summary sits at a STABLE, GUESSABLE address —
   * `(pubkey, 33369, podcast:guid:<feedGuid>)` — so a single `#d` filter
   * answers "who has streamed to this show", each answer carrying a total and
   * a date range rather than needing anyone to assemble one. It is also
   * monotonic, and therefore permanent by design.
   *
   * No new fact is revealed: the receipts are public and already `#i`-indexed.
   * What changes is the cost of asking, from a query plus arithmetic to one
   * lookup. That is enough of a difference to be its own switch.
   */
  streamSummaries: {
    get: (): boolean => safeGet(KEYS.streamSummaries) === '1',
    set: (v: boolean): boolean => safeSet(KEYS.streamSummaries, v ? '1' : '0'),
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

  /** /api/episode-by-guid result, keyed '<feedGuid>:<itemGuid>'. Same TTL and
   *  eviction class as podcastMeta — a network-regenerable display cache. */
  episodeMeta: {
    get: (key: string): Episode | null =>
      getTimed<Episode>(`${KEYS.episodeMetaPrefix}:${key}`, PODCAST_META_TTL_MS),
    set: (key: string, v: Episode) =>
      setTimed(`${KEYS.episodeMetaPrefix}:${key}`, v),
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

    /**
     * Every profile this device has cached, as [pubkey, metadata] pairs.
     *
     * For the @-mention picker, which needs to answer "who do I know called
     * ali…" on a keystroke with no network at all. Reading each entry through
     * `get` above rather than parsing here keeps the TTL, the negative-cache
     * rule and the re-coercion in ONE place — a second parser would be the one
     * that ships a non-string `name` to a `.trim()` call.
     *
     * Misses (`null`) and expired entries are skipped: they carry no name, so
     * they are nothing to offer. Bounded by however many profiles this device
     * has seen, which is the same set `get` already serves one at a time.
     */
    all: (): [string, ProfileMetadata][] => {
      if (!isBrowser()) return [];
      const out: [string, ProfileMetadata][] = [];
      for (const key of rawKeys()) {
        if (!key.startsWith(`${KEYS.profilePrefix}:`)) continue;
        const pubkey = key.slice(KEYS.profilePrefix.length + 1);
        const meta = storage.profile.get(pubkey);
        if (meta) out.push([pubkey, meta]);
      }
      return out;
    },
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
    /**
     * Returns whether the value reached DISK. Don't drop that answer: a mute
     * that only made it into `safeSet`'s in-memory mirror filters correctly for
     * the rest of the session and is gone on the next load, which presents
     * exactly as "I muted them and they came back". The relay copy is the only
     * durable record in that case, so a signed-in caller must still publish.
     */
    set: (npub: string | null | undefined, v: MuteListState): boolean =>
      safeSet(identityKey(KEYS.mutedPrefix, npub), JSON.stringify(v)),
    /**
     * Record the ciphertext whose plaintext this device holds, leaving every
     * other field alone.
     *
     * Read-modify-write rather than a field on the caller's own `set`, because
     * the two writers are a publish that has just landed and a hydrate that has
     * just read — and the publish fires from a debounce, up to 1.5 s after the
     * state it was built from was persisted. Writing the whole state from there
     * would take a mute the user made in between back off the list.
     */
    rememberPrivateContent: (npub: string | null | undefined, content: string): boolean => {
      const cur = storage.muted.get(npub);
      if (cur.knownPrivateContent === content) return true;
      return storage.muted.set(npub, { ...cur, knownPrivateContent: content });
    },
  },

  /**
   * Streaming settings — on/off, the per-minute rate, the unit, and the per-track
   * amount. Two scopes, resolved by `resolveStreamPlan` in
   * lib/v4v/streaming.ts: a per-show override wins over the global rate.
   *
   * **The rate and the on/off switch are separate keys.** The control is a
   * toggle plus a number, and a user who switches streaming off must get their
   * number back when they switch it on again — so "off" can never be encoded as
   * a 0 in the rate field, which is what destroyed it. (Encoding off as a
   * negative rate was the other option and is worse: `saneRate` rejects
   * negatives as corruption, so overloading the sign fights the rule that a
   * corrupt value must read as off.)
   *
   * **`getShow` stays tri-state, and that is load-bearing.** Absent means "no
   * opinion — follow the global rate"; `0` means "never stream this show" and
   * must survive the global rate being raised later. It is now DERIVED from the
   * per-show on/off flag rather than from a magic zero, so the rule is
   * structural instead of conventional.
   *
   * Both scopes read the number through `saneRate`, so a corrupted key degrades
   * to off rather than to an unbounded spend. The cap is deliberately low —
   * anyone wanting to move more than that per minute wants a boost, which asks.
   *
   * **No migration from any earlier shape, deliberately.** A rate present with
   * no on-flag reads as OFF, which is the safe direction for a feature that
   * spends money unattended and must be opted into.
   */
  streaming: {
    /**
     * The GLOBAL EFFECTIVE rate. 0 = streaming off, which is the default for a
     * new install and for any half-written state.
     */
    get: (): number | null => (readOn(KEYS.streamOn) === true ? saneRate(safeGet(KEYS.streamRate)) : 0),
    /** Is the global switch on? */
    isOn: (): boolean => readOn(KEYS.streamOn) === true,
    /** The remembered number the input field shows, regardless of on/off. */
    getRemembered: (): number =>
      saneRate(safeGet(KEYS.streamRate)) ?? DEFAULT_STREAM_RATE_PER_MIN,
    /**
     * How many shows carry an explicit `on` override.
     *
     * The global switch cannot promise "nothing is sent" — a per-show override
     * outranks it by design (that's the whole point of the tri-state), so a
     * global control reading OFF while a show streams in the background is
     * telling the user something false about their own money. This is what
     * lets it say so instead. Counts only explicit `'1'`; a show following the
     * global rate is already covered by the switch itself.
     */
    showsExplicitlyOn: (): number => {
      const prefix = `${KEYS.streamOn}:`;
      return safeKeys().filter((k) => k.startsWith(prefix) && safeGet(k) === '1').length;
    },
    /**
     * Flip the global switch. Turning it on with nothing remembered seeds the
     * default, so `get()` can never answer "on but no rate" — which would read
     * as off and make the switch lie about what it just did.
     */
    setOn: (on: boolean) => {
      if (on && saneRate(safeGet(KEYS.streamRate)) === null) {
        safeSet(KEYS.streamRate, String(DEFAULT_STREAM_RATE_PER_MIN));
      }
      safeSet(KEYS.streamOn, on ? '1' : '0');
      streamRateObservable.notify();
    },
    /** Set the remembered rate. Never touches the on/off switch. */
    setRate: (satsPerMin: number) => {
      const n = Math.min(STREAM_RATE_MAX_PER_MIN, Math.max(1, Math.floor(satsPerMin)));
      safeSet(KEYS.streamRate, String(n));
      streamRateObservable.notify();
    },

    /**
     * The SHOW EFFECTIVE rate. null = no override, follow the global rate;
     * 0 = never stream this show, outranking the global rate.
     */
    getShow: (showKey: string): number | null => {
      if (!showKey) return null;
      const on = readOn(`${KEYS.streamOn}:${showKey}`);
      if (on === null) return null;
      if (on === false) return 0;
      // Explicitly on with no number of its own falls back to the remembered
      // global rate — "on" must never silently mean "off". setShowOn seeds a
      // number when the user flips a show on, so this only catches a
      // hand-edited or half-written key, but the UI resolves the same way and
      // the two must not be able to disagree about what is being spent.
      return saneRate(safeGet(`${KEYS.streamRate}:${showKey}`))
        ?? saneRate(safeGet(KEYS.streamRate))
        ?? DEFAULT_STREAM_RATE_PER_MIN;
    },
    /** null = this show has no opinion. */
    getShowOn: (showKey: string): boolean | null =>
      showKey ? readOn(`${KEYS.streamOn}:${showKey}`) : null,
    /** null = nothing remembered for this show. */
    getShowRemembered: (showKey: string): number | null =>
      showKey ? saneRate(safeGet(`${KEYS.streamRate}:${showKey}`)) : null,
    /**
     * `true`/`false` write an explicit per-show opinion; `null` clears EVERY
     * show key so the show goes back to following the global settings. Clearing
     * all of them matters — an invisible per-show number or unit left behind
     * would ambush the user the next time they flipped that show on, and the
     * unit is the worse of the two: 100 means something very different per
     * minute than it does per track.
     */
    setShowOn: (showKey: string, on: boolean | null) => {
      if (!showKey) return;
      const onKey = `${KEYS.streamOn}:${showKey}`;
      const rateKey = `${KEYS.streamRate}:${showKey}`;
      if (on === null) {
        safeRemove(onKey);
        safeRemove(rateKey);
        safeRemove(`${KEYS.streamMode}:${showKey}`);
        safeRemove(`${KEYS.streamAmount}:${showKey}`);
      } else {
        if (on && saneRate(safeGet(rateKey)) === null) {
          safeSet(rateKey, String(storage.streaming.getRemembered()));
        }
        safeSet(onKey, on ? '1' : '0');
      }
      streamRateObservable.notify();
    },
    setShowRate: (showKey: string, satsPerMin: number) => {
      if (!showKey) return;
      const n = Math.min(STREAM_RATE_MAX_PER_MIN, Math.max(1, Math.floor(satsPerMin)));
      safeSet(`${KEYS.streamRate}:${showKey}`, String(n));
      streamRateObservable.notify();
    },
    /**
     * True when this scope's switch is only held in memory, so a reload loses
     * it. Same soft-hint role as `nwcUri.isEphemeral`, and it matters more
     * here: the switch reads straight back out of storage with no local state,
     * so before the memory mirror existed a failed write left the control
     * visibly inert — the user tapped ON and it stayed OFF, with no error.
     */
    isEphemeral: (showKey?: string | null): boolean =>
      isMemoryOnly(showKey ? `${KEYS.streamOn}:${showKey}` : KEYS.streamOn),

    // --- Unit: per minute, or a fixed amount per track ---------------------
    //
    // The rate path pays `rate × time`, so a six-minute song earns three times
    // what a two-minute one does. Per-track pays both the same, which is how a
    // listener thinks about what a song is worth.
    //
    // Mode and amount are their own keys, and the amount is deliberately NOT
    // stored in `streamRate`: the two numbers mean different things and both
    // have to survive switching the unit back and forth, exactly as the rate
    // survives the on/off switch. Precedence mirrors the rate's — a per-show
    // value overrides the global one, absent means "follow the default".

    /** The global unit. Absent reads as 'rate', the behaviour before this key. */
    getMode: (): StreamMode => readMode(KEYS.streamMode) ?? 'rate',
    /** null = this show has no opinion, follow the global unit. */
    getShowMode: (showKey: string): StreamMode | null =>
      showKey ? readMode(`${KEYS.streamMode}:${showKey}`) : null,
    /** The unit actually in force for a scope. */
    getEffectiveMode: (showKey?: string | null): StreamMode =>
      (showKey ? readMode(`${KEYS.streamMode}:${showKey}`) : null)
      ?? readMode(KEYS.streamMode)
      ?? 'rate',
    setMode: (mode: StreamMode) => {
      safeSet(KEYS.streamMode, mode);
      streamRateObservable.notify();
    },
    setShowMode: (showKey: string, mode: StreamMode | null) => {
      if (!showKey) return;
      const key = `${KEYS.streamMode}:${showKey}`;
      if (mode === null) safeRemove(key);
      else safeSet(key, mode);
      streamRateObservable.notify();
    },

    /** The remembered per-track amount the input shows, regardless of unit. */
    getAmountRemembered: (): number =>
      saneAmount(safeGet(KEYS.streamAmount)) ?? DEFAULT_STREAM_AMOUNT_PER_TRACK,
    /** null = nothing remembered for this show. */
    getShowAmountRemembered: (showKey: string): number | null =>
      showKey ? saneAmount(safeGet(`${KEYS.streamAmount}:${showKey}`)) : null,
    /**
     * The amount actually in force. Falls back show → global → default, the
     * same chain `getShow` uses for the rate, so "on" can never resolve to an
     * amount of zero and make the control lie about what it is spending.
     */
    getEffectiveAmount: (showKey?: string | null): number =>
      (showKey ? saneAmount(safeGet(`${KEYS.streamAmount}:${showKey}`)) : null)
      ?? saneAmount(safeGet(KEYS.streamAmount))
      ?? DEFAULT_STREAM_AMOUNT_PER_TRACK,
    setAmount: (sats: number) => {
      const n = Math.min(STREAM_AMOUNT_MAX_SATS, Math.max(1, Math.floor(sats)));
      safeSet(KEYS.streamAmount, String(n));
      streamRateObservable.notify();
    },
    setShowAmount: (showKey: string, sats: number) => {
      if (!showKey) return;
      const n = Math.min(STREAM_AMOUNT_MAX_SATS, Math.max(1, Math.floor(sats)));
      safeSet(`${KEYS.streamAmount}:${showKey}`, String(n));
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
        // posCarryMs is normalized rather than rejected: it's sub-second
        // billing dust, not a balance, so a record written before the field
        // existed (or with junk in it) should start fresh rather than throw
        // away real accrued sats sitting in `buckets`.
        const posCarryMs =
          typeof v.posCarryMs === 'number' && Number.isFinite(v.posCarryMs) && v.posCarryMs >= 0
            ? v.posCarryMs
            : 0;
        // billedMs — the payout clock — is normalized on exactly the same terms
        // and for the same reason. Every ledger written before it existed lacks
        // the field, and rejecting those would discard real accrued sats in
        // `buckets` on the first load after the update. Starting the clock at 0
        // costs at most one deferred payout; dropping the ledger costs money.
        const billedMs =
          typeof v.billedMs === 'number' && Number.isFinite(v.billedMs) && v.billedMs >= 0
            ? v.billedMs
            : 0;
        // The per-track double-pay guards. Normalized like posCarryMs rather
        // than rejected — a record predating them must not throw away real sats
        // in `buckets`. Losing them errs toward paying a track twice, so they
        // are read defensively but never treated as a reason to drop the ledger.
        const creditedRun = typeof v.creditedRun === 'string' ? v.creditedRun : undefined;
        const creditedAt: Record<string, number> = {};
        if (v.creditedAt && typeof v.creditedAt === 'object' && !Array.isArray(v.creditedAt)) {
          for (const [bucket, ms] of Object.entries(v.creditedAt)) {
            if (typeof ms === 'number' && Number.isFinite(ms)) creditedAt[bucket] = ms;
          }
        }
        return { ...v, buckets, posCarryMs, billedMs, creditedRun, creditedAt } as StreamLedger;
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
    /** Returns whether the value reached DISK. See `persistFavorites` in
     *  lib/store.ts for why a caller must not drop that answer. */
    set: (npub: string | null | undefined, v: Record<string, FavoritePodcast>): boolean =>
      safeSet(identityKey(KEYS.favoritesPrefix, npub), JSON.stringify(v)),
  },

  /** Favorited episodes, keyed by item guid. Same npub namespacing as favorites. */
  favoriteEpisodes: {
    get: (npub: string | null | undefined): Record<string, FavoriteEpisode> => {
      const raw = safeGet(identityKey(KEYS.favoriteEpisodesPrefix, npub));
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object'
          ? (parsed as Record<string, FavoriteEpisode>)
          : {};
      } catch {
        return {};
      }
    },
    /** Returns whether the value reached DISK — same contract as `favorites`. */
    set: (npub: string | null | undefined, v: Record<string, FavoriteEpisode>): boolean =>
      safeSet(identityKey(KEYS.favoriteEpisodesPrefix, npub), JSON.stringify(v)),
  },

  /**
   * What this device last agreed with the kind:10333 favorites list on.
   *
   * It answers the one question a SECOND writer to a shared replaceable event
   * must answer and a single writer never faces: an entry on the relay and
   * absent from local state is either something another app added, or something
   * this device just unfavorited. Prefer the relay and unfavoriting silently
   * stops working; prefer local state and you delete the other app's entries.
   *
   * Losing it is not fatal — an empty baseline yields no removals, so the next
   * publish is a pure union — but it does mean one unfavorite fails to
   * propagate. So it is a setting, not a cache, and never appears in
   * EVICTABLE_PREFIXES.
   *
   * **It starts EMPTY, and is deliberately NOT seeded from the two pre-10333
   * keys.** Those describe a different event at a different address. Carrying
   * them over asserts that this device published those ids *to the 10333 list*,
   * which it never did — so any entry sitting on 10333 that this device did not
   * write reads as "mine, and I removed it" and gets deleted on the first
   * publish. That shipped for one build and deleted a real album favorite that
   * existed only on the other app's side: the id was in the old baseline, absent
   * from local, and the merge did exactly what a truthful baseline would have
   * meant.
   *
   * Empty is both safe and correct here. Safe, because an empty baseline yields
   * no removals — the first publish is a pure union. Correct, because a removal
   * this device made before the cutover was already propagated to the OLD list;
   * it has no pending removals against a list it has never written to. The only
   * cost is that an unfavorite made between hydration and the first successful
   * publish waits for the next toggle, which is recoverable in a way that
   * deleting another app's entry is not.
   */
  favBaseline: {
    get: (npub: string | null | undefined): FavoritesBaseline => {
      const raw = safeGet(identityKey(KEYS.favBaselinePrefix, npub));
      if (!raw) return { feeds: [], items: [] };
      const strings = (v: unknown): string[] =>
        (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      try {
        const parsed = JSON.parse(raw);
        // The two private arrays are read back as [] when absent rather than
        // left undefined, so a baseline written before the private half existed
        // reads as all-public — which is exactly what it is. Reading them as
        // "unknown" instead would make the first private cycle on an upgraded
        // device treat every entry as another app's.
        return {
          feeds: strings(parsed?.feeds),
          items: strings(parsed?.items),
          privateFeeds: strings(parsed?.privateFeeds),
          privateItems: strings(parsed?.privateItems),
        };
      } catch {
        return { feeds: [], items: [] };
      }
    },
    set: (npub: string | null | undefined, v: FavoritesBaseline) => {
      safeSet(identityKey(KEYS.favBaselinePrefix, npub), JSON.stringify(v));
    },
  },

  /**
   * Where this account's favorites go: public tags, encrypted `content`, or
   * nowhere.
   *
   * THREE states plus absent, and absent is load-bearing — it means "never
   * chosen", which is what the first-favorite prompt asks about and what the
   * hydrator seeds from the wire. Collapsing it to a 'public' default would
   * publish a list before the user was ever offered the choice, which is the
   * one ordering this feature exists to get right.
   *
   * Per-npub, because it describes an identity's list rather than this machine.
   * `'off'` is the exception in spirit — it stops THIS device syncing — but it
   * still keys by npub so signing into a second account on the same browser
   * does not inherit a decision made about the first.
   */
  favPrivacy: {
    get: (npub: string | null | undefined): FavoritesPrivacy | null => {
      const v = safeGet(identityKey(KEYS.favPrivacyPrefix, npub));
      return v === 'public' || v === 'private' || v === 'off' ? v : null;
    },
    set: (npub: string | null | undefined, v: FavoritesPrivacy): boolean => {
      const landed = safeSet(identityKey(KEYS.favPrivacyPrefix, npub), v);
      favPrivacyObservable.notify();
      return landed;
    },
    clear: (npub: string | null | undefined) => {
      safeRemove(identityKey(KEYS.favPrivacyPrefix, npub));
      favPrivacyObservable.notify();
    },
  },

  /**
   * "This device is holding no favorites ON PURPOSE."
   *
   * An empty store beside a baseline that claims ids has two readings, and
   * until this key there was no way to tell them apart:
   *
   *   the store has not hydrated yet   → believing the baseline deletes the
   *                                      user's whole library (2026-08-21)
   *   the user unfavorited everything  → NOT believing it means the removal
   *                                      never publishes, and the next reload
   *                                      re-adopts every entry off the relay
   *
   * `baselineIsTrustworthy` refused both, which made the second impossible:
   * "delete all my favorites" silently did nothing and they came back. This
   * records the difference at the only moment it is knowable — the removal
   * itself. An unhydrated store never calls `removeFavorite`, so a set flag is
   * proof of intent rather than an inference from state.
   *
   * Per-npub, and NOT evictable: losing it re-opens the bug it closes.
   */
  favCleared: {
    get: (npub: string | null | undefined): boolean =>
      safeGet(identityKey(KEYS.favClearedPrefix, npub)) === '1',
    set: (npub: string | null | undefined, on: boolean) => {
      if (on) safeSet(identityKey(KEYS.favClearedPrefix, npub), '1');
      else safeRemove(identityKey(KEYS.favClearedPrefix, npub));
    },
  },

  /**
   * The device escape hatch for the private half, ahead of
   * `PRIVATE_FAVORITES_ENABLED`. Set by `window.bmbEnablePrivateFavorites()`.
   */
  favPrivateOptIn: {
    get: (): boolean => safeGet(KEYS.favPrivateOptIn) === '1',
    set: (on: boolean) => {
      if (on) safeSet(KEYS.favPrivateOptIn, '1');
      else safeRemove(KEYS.favPrivateOptIn);
      favPrivacyObservable.notify();
    },
  },

  /**
   * The NWC URI parked across a same-account sign-out → sign-in inside one tab.
   *
   * sessionStorage, not localStorage, and deliberately so: it dies with the tab,
   * which is the whole reason it's an acceptable place to hold a **spending
   * credential** at all. That's why it doesn't go through safeGet/safeSet —
   * those read and write localStorage, and the memory mirror would outlive the
   * window this value is allowed to exist in.
   *
   * It IS here rather than inline, because the key was hand-written as a
   * template literal in four places across two files. CLAUDE.md's rule — every
   * `bmb:*` access through a typed helper — was written for localStorage and
   * this slipped through the gap. The stakes are the reason it matters: the
   * remove in the disconnect path is what stops a wallet the user disconnected
   * coming back on the next sign-in, and it was one character away from no
   * longer matching the writer, with nothing to catch the mismatch.
   */
  nwcSessionUri: {
    get: (npub: string | null | undefined): string | null => {
      if (!isBrowser()) return null;
      try { return sessionStorage.getItem(identityKey(KEYS.nwcUriSessPrefix, npub)); } catch { return null; }
    },
    set: (npub: string | null | undefined, uri: string) => {
      if (!isBrowser()) return;
      try { sessionStorage.setItem(identityKey(KEYS.nwcUriSessPrefix, npub), uri); } catch { /* blocked */ }
    },
    clear: (npub: string | null | undefined) => {
      if (!isBrowser()) return;
      try { sessionStorage.removeItem(identityKey(KEYS.nwcUriSessPrefix, npub)); } catch { /* blocked */ }
    },
  },

  /**
   * Client-side circuit breaker for Podcast Index metadata resolution.
   *
   * sessionStorage for the same reason as above — it should survive a reload
   * (a PI outage doesn't end because someone refreshed) but not outlive the tab.
   */
  /**
   * The in-flight Amber (NIP-55) request, and the result it comes back with.
   *
   * These exist because Amber returns a `callbackUrl` result by NAVIGATING to
   * it, which reloads the page and destroys the promise `invokeAmber`'s caller
   * is awaiting. Nothing in memory survives that, so the request has to be
   * recognisable on the other side of the load.
   *
   * localStorage, NOT sessionStorage, and that was decided by measurement
   * rather than taste. The first version used sessionStorage, reasoning a
   * request should die with the tab. On a Pixel 6 against a real https origin,
   * **Brave opens Amber's callback in a NEW TAB** — tab count went 15 to 16 —
   * and sessionStorage is per-tab, so the pending record was never there. The
   * callback page said so honestly and offered a manual paste, which is the
   * right failure, but it is still a failure: the automatic path never ran.
   *
   * THE PRICE OF localStorage IS THAT THIS REACHES DISK, so the rule that
   * replaces the tab lifetime is: **neither key may ever hold a secret.**
   * `amberPending` carries no payload at all, and `amberResult` is gated by
   * `AMBER_PERSISTABLE_TYPES` — a decrypt result is the user's PLAINTEXT and is
   * refused rather than written.
   *
   * `get` is defensive in the `streamPending` style — every field is checked and
   * anything malformed reads as absent. The input is attacker-reachable: any
   * page or app can navigate to /amber-callback, and a half-written record must
   * fail closed rather than match something.
   */
  amberPending: {
    get: (): AmberPending | null => {
      const raw = safeGet(KEYS.amberPending);
      if (!raw) return null;
      try {
        const v = JSON.parse(raw) as Record<string, unknown>;
        const { rid, type, ts } = v;
        if (typeof rid !== 'string' || !/^[0-9a-f]{32}$/.test(rid)) return null;
        if (typeof type !== 'string' || !type) return null;
        if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return null;
        // `origin` is optional: it records the route to return to, and a record
        // written before it existed is still a usable one.
        const origin = typeof v.origin === 'string' ? v.origin : undefined;
        return { rid, type: type as AmberPending['type'], ts, origin };
      } catch {
        return null;
      }
    },
    set: (pending: AmberPending) => { safeSet(KEYS.amberPending, JSON.stringify(pending)); },
    clear: () => { safeRemove(KEYS.amberPending); },
  },

  amberResult: {
    get: (): AmberParkedResult | null => {
      const raw = safeGet(KEYS.amberResult);
      if (!raw) return null;
      try {
        const v = JSON.parse(raw) as Record<string, unknown>;
        const { rid, type, value, ts } = v;
        if (typeof rid !== 'string' || !/^[0-9a-f]{32}$/.test(rid)) return null;
        // Re-checked on the way OUT as well as in: a value already on disk from
        // an older build must not become readable by widening the set later.
        if (typeof type !== 'string' || !AMBER_PERSISTABLE_TYPES.has(type)) return null;
        if (typeof value !== 'string' || !value) return null;
        if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return null;
        return { rid, type: type as AmberPending['type'], value, ts };
      } catch {
        return null;
      }
    },
    /**
     * Park a result. Returns false — and writes NOTHING — for a type whose
     * result is not safe to put on disk. This is the guard that keeps the
     * localStorage decision honest; do NOT move it to the call site, because
     * the caller that gets it wrong will be a future one adding a type to
     * RESUMABLE_TYPES without reading any of this.
     */
    set: (result: AmberParkedResult): boolean => {
      if (!AMBER_PERSISTABLE_TYPES.has(result.type)) return false;
      safeSet(KEYS.amberResult, JSON.stringify(result));
      return true;
    },
    /** Read and delete in one step. A parked result is single-use: leaving it
     *  behind would let a stale answer resolve a later request. */
    take: (): AmberParkedResult | null => {
      const got = storage.amberResult.get();
      storage.amberResult.clear();
      return got;
    },
    clear: () => { safeRemove(KEYS.amberResult); },
  },

  piBreaker: {
    /** True while PI is considered usable. Fails OPEN: unreadable storage must not disable resolution. */
    isAlive: (): boolean => {
      if (!isBrowser()) return true;
      try { return sessionStorage.getItem(KEYS.piDead) !== '1'; } catch { return true; }
    },
    trip: () => {
      if (!isBrowser()) return;
      try { sessionStorage.setItem(KEYS.piDead, '1'); } catch { /* blocked */ }
    },
    reset: () => {
      if (!isBrowser()) return;
      try { sessionStorage.removeItem(KEYS.piDead); } catch { /* blocked */ }
    },
  },
};
