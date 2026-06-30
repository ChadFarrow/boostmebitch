import { nip19, type Event } from 'nostr-tools';
import { withPool, FEED_QUERY_MAX_WAIT_MS } from './pool';
import { DEFAULT_RELAYS, sanitizeRelays } from './relays';
import { fetchProfile } from './profile';
import { storage } from '../storage';
import { fnvHash } from '../util';
import type { Episode, Podcast, ValueBlock, ValueRecipient } from '../types';
import type { ProfileMetadata } from './auth';

// A live stream's id is its NIP-33 replaceable address tail: `<pubkey>:<dTag>`.
// These helpers centralize building/parsing it (also carried as Episode.guid).
export function streamIdOf(pubkey: string, dTag: string): string {
  return `${pubkey}:${dTag}`;
}
export function parseStreamId(id: string): { pubkey: string; dTag: string } | null {
  const i = id.indexOf(':');
  if (i !== 64) return null; // pubkey is exactly 64 hex chars
  return { pubkey: id.slice(0, i), dTag: id.slice(i + 1) };
}
export function isLiveStreamId(s: string | undefined | null): boolean {
  return !!s && /^[0-9a-f]{64}:/.test(s);
}

export interface NostrLiveStream {
  /** NIP-33 replaceable address: `${pubkey}:${dTag}` */
  id: string;
  eventId: string;
  dTag: string;
  pubkey: string;
  npub: string;
  title: string;
  summary?: string;
  image?: string;
  /** First `streaming` tag URL — HLS, RTMP, etc. */
  streamUrl?: string;
  status: 'live' | 'planned' | 'ended';
  /** Scheduled/actual start, unix seconds. */
  startsAt?: number;
  endsAt?: number;
  /** `p` tag participants with their declared role. */
  participants: Array<{ pubkey: string; role: string }>;
  hashtags: string[];
  /** NIP-53 `zap` split tags: pubkeys + relative weights for V4V. */
  zapWeights: Array<{ pubkey: string; relay?: string; weight: number }>;
  currentViewers?: number;
  rawEvent: Event;
}

// Union of DEFAULT_RELAYS and a few extras known to carry kind:30311 events
// (e.g. zap.stream publishes to these).
export const LIVE_STREAM_RELAYS = sanitizeRelays([
  ...DEFAULT_RELAYS,
  'wss://relay.zap.stream',
  'wss://nostr.wine',
]);

// A `live`-tagged event whose newest version is older than this is treated as a
// stale/ended broadcast and dropped (streams that ended without an `ended`
// status update). Generous enough not to hide a real stream whose client
// updates the event infrequently.
const LIVE_FRESH_SECS = 2 * 3600;

function parseNostrLiveStream(event: Event): NostrLiveStream {
  const getTag = (name: string) => event.tags.find((t) => t[0] === name)?.[1];
  const getAllTags = (name: string) =>
    event.tags.filter((t) => t[0] === name).map((t) => t[1]).filter(Boolean) as string[];

  const dTag = getTag('d') ?? event.id;
  const rawStatus = getTag('status') ?? '';
  const status: NostrLiveStream['status'] =
    rawStatus === 'live' ? 'live' : rawStatus === 'planned' ? 'planned' : 'ended';

  let npub = '';
  try { npub = nip19.npubEncode(event.pubkey); } catch { /* ignore */ }

  // NIP-53 zap splits: ["zap", "<pubkey>", "<relay>", "<weight>"]. Default a
  // missing/garbage weight to 1, but preserve an explicit 0 (host opted this
  // participant out) — `parseFloat(...) || 1` would wrongly turn 0 into 1.
  const zapWeights = event.tags
    .filter((t) => t[0] === 'zap' && typeof t[1] === 'string' && t[1].length === 64)
    .map((t) => {
      const w = parseFloat(t[3] ?? '1');
      return {
        pubkey: t[1],
        relay: t[2] || undefined,
        weight: Number.isFinite(w) ? w : 1,
      };
    });

  return {
    id: streamIdOf(event.pubkey, dTag),
    eventId: event.id,
    dTag,
    pubkey: event.pubkey,
    npub,
    title: getTag('title') ?? 'Untitled Stream',
    summary: getTag('summary') ?? getTag('about'),
    image: getTag('image') ?? getTag('thumb'),
    streamUrl: getTag('streaming'),
    status,
    startsAt: getTag('starts') ? parseInt(getTag('starts')!, 10) : undefined,
    endsAt: getTag('ends') ? parseInt(getTag('ends')!, 10) : undefined,
    participants: event.tags
      .filter((t) => t[0] === 'p' && typeof t[1] === 'string' && t[1].length === 64)
      .map((t) => ({ pubkey: t[1], role: t[3] ?? 'participant' })),
    hashtags: getAllTags('t'),
    zapWeights,
    currentViewers: getTag('current_participants')
      ? parseInt(getTag('current_participants')!, 10)
      : undefined,
    rawEvent: event,
  };
}

/**
 * Fetch NIP-53 kind:30311 live stream events from the relay pool.
 * Returns only live and planned streams, deduplicated by NIP-33 address,
 * sorted live-first then by start time.
 */
export async function fetchNostrLiveStreams(opts?: {
  limit?: number;
}): Promise<NostrLiveStream[]> {
  const { limit = 200 } = opts ?? {};
  const relays = LIVE_STREAM_RELAYS;

  return withPool(relays, async (pool) => {
    try {
      const events = await pool.querySync(
        relays,
        {
          kinds: [30311],
          // 7-day window catches planned streams scheduled ahead-of-time
          // without pulling stale ended broadcasts from months ago
          since: Math.floor(Date.now() / 1000) - 7 * 86400,
          limit,
        },
        { maxWait: FEED_QUERY_MAX_WAIT_MS },
      );

      // Deduplicate replaceable events: keep the newest version per NIP-33 address
      const byAddr = new Map<string, Event>();
      for (const e of events) {
        const dTag = e.tags.find((t) => t[0] === 'd')?.[1] ?? e.id;
        const addr = `${e.pubkey}:${dTag}`;
        const existing = byAddr.get(addr);
        if (!existing || e.created_at > existing.created_at) {
          byAddr.set(addr, e);
        }
      }

      // A genuinely-live kind:30311 event is re-published periodically while
      // broadcasting (zap.stream et al. bump `current_participants` ~every
      // minute), so an active stream always has a fresh `created_at`. When a
      // stream ends, most clients never publish the `ended` status — they just
      // stop updating — so a stale event tagged `live` is almost certainly a
      // dead broadcast. Require live events to have been updated recently;
      // planned streams are exempt (their event is set once, ahead of time).
      const liveFreshAfter = Math.floor(Date.now() / 1000) - LIVE_FRESH_SECS;

      return Array.from(byAddr.values())
        .map(parseNostrLiveStream)
        .filter((s) =>
          s.status === 'planned' ||
          (s.status === 'live' && s.rawEvent.created_at >= liveFreshAfter),
        )
        .sort((a, b) => {
          // Upcoming (planned) first, then live. Within a group, newest first.
          if (a.status !== b.status) return a.status === 'planned' ? -1 : 1;
          return (b.startsAt ?? 0) - (a.startsAt ?? 0);
        });
    } catch {
      return [];
    }
  });
}

/**
 * Encode a stream's NIP-33 address as a shareable `naddr` (kind:30311 +
 * pubkey + d-tag + a couple of relay hints) for deep-link URLs.
 */
export function streamNaddr(pubkey: string, dTag: string): string {
  return nip19.naddrEncode({
    kind: 30311,
    pubkey,
    identifier: dTag,
    // Lead with the stream-specific relays (zap.stream, fountain) — a stream's
    // event often lives ONLY on its host's relay, so generic defaults aren't
    // enough relay hints for other clients to resolve the naddr.
    relays: ['wss://relay.zap.stream', 'wss://relay.fountain.fm', 'wss://nos.lol'],
  });
}

/**
 * Fetch a single kind:30311 stream by its NIP-33 address (used by the
 * `?stream=<naddr>` deep-link). No status/freshness filter — opens exactly what
 * was shared. Returns the newest matching event, or null if none is found.
 */
export async function fetchLiveStreamByAddr(
  pubkey: string,
  dTag: string,
  relayHints: string[] = [],
): Promise<NostrLiveStream | null> {
  const relays = sanitizeRelays([...relayHints, ...LIVE_STREAM_RELAYS]).slice(0, 20);
  // Use querySync (waits for all relays to EOSE or maxWait), NOT fetchLatestEvent
  // — a stream's event often lives ONLY on a slow host relay (e.g. fountain.fm),
  // and fetchLatestEvent resolves as soon as the fast empty relays EOSE, giving
  // up before the slow one delivers → "stream not found" on a valid link. A
  // deep-link MUST find the event, so completeness beats the early-resolve.
  return withPool(relays, async (pool) => {
    try {
      // Query by AUTHOR only (no `#d` tag filter) and match the d-tag
      // client-side. Some relays — notably fountain.fm, which is often the only
      // relay carrying a stream's event — don't honor the `#d` tag filter
      // reliably in-browser, so the filtered query came back empty and the
      // deep-link said "not found" even though the main-page list (a broad,
      // unfiltered query) found the same stream. A host has few streams, so
      // fetching all and filtering is cheap.
      const events = await pool.querySync(
        relays,
        { kinds: [30311], authors: [pubkey], limit: 30 },
        { maxWait: FEED_QUERY_MAX_WAIT_MS },
      );
      const matches = events
        .filter((e) => (e.tags.find((t) => t[0] === 'd')?.[1] ?? '') === dTag)
        .sort((a, b) => b.created_at - a.created_at);
      return matches[0] ? parseNostrLiveStream(matches[0]) : null;
    } catch {
      return null;
    }
  });
}

/**
 * Fetch a host's *current* live stream by pubkey — the backing query for the
 * permanent `/live/<npub>` share link. Unlike `fetchLiveStreamByAddr` (which
 * pins one broadcast by its dTag), this ignores the dTag entirely so the link
 * stays valid across broadcasts: most clients mint a fresh random dTag per
 * stream, so a host's durable identity is their pubkey, not any one naddr.
 *
 * Priority: a genuinely-live stream (fresh `live` status, newest first); else
 * the soonest upcoming `planned` stream (so the page can show a "next up" hint);
 * else null. Ended broadcasts are never returned — we don't auto-open a dead
 * stream behind a permanent link.
 */
export async function fetchLatestStreamByPubkey(
  pubkey: string,
  relayHints: string[] = [],
): Promise<NostrLiveStream | null> {
  const relays = sanitizeRelays([...relayHints, ...LIVE_STREAM_RELAYS]).slice(0, 20);
  return withPool(relays, async (pool) => {
    try {
      // Query by AUTHOR only (no `#d` filter) — same reasoning as
      // fetchLiveStreamByAddr: fountain.fm and other host relays don't honor
      // tag filters reliably in-browser. A host has few streams, so fetch all
      // and pick client-side.
      const events = await pool.querySync(
        relays,
        { kinds: [30311], authors: [pubkey], limit: 50 },
        { maxWait: FEED_QUERY_MAX_WAIT_MS },
      );

      // Dedupe replaceable events by NIP-33 address (newest version wins).
      const byAddr = new Map<string, Event>();
      for (const e of events) {
        const dTag = e.tags.find((t) => t[0] === 'd')?.[1] ?? e.id;
        const addr = `${e.pubkey}:${dTag}`;
        const existing = byAddr.get(addr);
        if (!existing || e.created_at > existing.created_at) byAddr.set(addr, e);
      }

      const liveFreshAfter = Math.floor(Date.now() / 1000) - LIVE_FRESH_SECS;
      const streams = Array.from(byAddr.values()).map(parseNostrLiveStream);

      // A fresh `live` event = broadcasting right now (clients re-publish it
      // periodically). Newest first if the host somehow has two.
      const live = streams
        .filter((s) => s.status === 'live' && s.rawEvent.created_at >= liveFreshAfter)
        .sort((a, b) => (b.startsAt ?? 0) - (a.startsAt ?? 0));
      if (live[0]) return live[0];

      // Otherwise the soonest upcoming planned stream (drives the "next up" hint
      // on the offline placeholder).
      const planned = streams
        .filter((s) => s.status === 'planned')
        .sort((a, b) => (a.startsAt ?? Infinity) - (b.startsAt ?? Infinity));
      return planned[0] ?? null;
    } catch {
      return null;
    }
  });
}

/**
 * Resolve a ValueBlock for V4V boosts against a Nostr live stream.
 *
 * Two paths:
 *  1. If the event has NIP-53 `zap` split tags → resolve each participant's
 *     Lightning address from their kind:0 profile and build a split ValueBlock.
 *  2. Most streams have no split tags (single host) → fall back to the host
 *     pubkey's own Lightning address as the sole 100% recipient.
 *
 * Returns null when no resolvable Lightning address is found.
 */
export async function resolveStreamV4V(
  stream: NostrLiveStream,
): Promise<ValueBlock | null> {
  // Build the candidate list: zap-split participants (dropping any the host
  // opted out with weight <= 0), or the host as the sole fallback.
  const splitCandidates = stream.zapWeights.filter((z) => z.weight > 0);
  const candidates: Array<{ pubkey: string; relay?: string; weight: number }> =
    splitCandidates.length
      ? splitCandidates
      : [{ pubkey: stream.pubkey, weight: 1 }];

  const results = await Promise.all(
    candidates.map(async ({ pubkey, relay, weight }) => {
      const cached = storage.profile.get(pubkey);
      let profile: ProfileMetadata | null | undefined = cached;
      // Re-fetch when absent (undefined) OR a cached miss (null): the recipient's
      // lud16 is what gates BOOST, and a streamer's profile can miss transiently
      // or live on the stream's relays (zap.stream/nostr.wine) rather than a
      // viewer's defaults — don't let one earlier miss hide BOOST for 15 min.
      // A cached profile object (even without lud16) is trusted, so this never
      // re-queries hosts that genuinely have no Lightning address in a hot loop.
      if (profile === undefined || profile === null) {
        const relays = sanitizeRelays([...(relay ? [relay] : []), ...LIVE_STREAM_RELAYS]);
        const fetched = await fetchProfile(pubkey, relays);
        if (fetched) profile = fetched;
      }
      const address = profile?.lud16 ?? profile?.lud06;
      if (!address) return null;
      const recipient: ValueRecipient = {
        name: profile?.display_name ?? profile?.name ?? pubkey.slice(0, 8),
        type: 'lnaddress',
        address,
        split: weight,
      };
      return recipient;
    }),
  );

  const recipients = results.filter((r): r is ValueRecipient => r !== null);
  if (!recipients.length) return null;
  return { type: 'lightning', method: 'lnaddress', recipients };
}

/**
 * Convert a NostrLiveStream to an Episode so the existing player, boost modal,
 * and live-item UI (LiveBadge, seek-bar hiding, "● LIVE streaming now") all
 * work without modification.
 */
export function streamToEpisode(
  stream: NostrLiveStream,
  value?: ValueBlock | null,
): Episode {
  return {
    id: fnvHash(stream.id),
    guid: stream.id,
    title: stream.title,
    description: stream.summary,
    enclosureUrl: stream.streamUrl ?? '',
    datePublished: stream.startsAt ?? Math.floor(Date.now() / 1000),
    feedId: 0,
    liveStatus: stream.status === 'planned' ? 'pending' : stream.status,
    liveStartTime: stream.startsAt,
    value: value ?? null,
  };
}

/**
 * Build a synthetic Podcast context for the player. The player stores
 * `current: { episode, podcast }` so a podcast stub is required even for
 * standalone live streams that have no PI feed.
 */
export function streamToPodcast(
  stream: NostrLiveStream,
  hostProfile?: ProfileMetadata | null,
): Podcast {
  return {
    id: 0,
    title: stream.title,
    author: hostProfile?.display_name ?? hostProfile?.name ?? stream.npub.slice(0, 12) + '…',
    description: stream.summary,
    image: stream.image ?? hostProfile?.picture,
    artwork: hostProfile?.picture,
  };
}
