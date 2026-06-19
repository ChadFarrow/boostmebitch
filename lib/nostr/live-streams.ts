import { nip19, type Event } from 'nostr-tools';
import { withPool, FEED_QUERY_MAX_WAIT_MS } from './pool';
import { DEFAULT_RELAYS, sanitizeRelays } from './relays';
import { fetchProfile } from './profile';
import { storage } from '../storage';
import type { Episode, Podcast, ValueBlock, ValueRecipient } from '../types';
import type { ProfileMetadata } from './auth';

// FNV-1a hash for stable numeric IDs (mirrors the one in lib/pi.ts)
function fnvHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0x7fffffff;
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
const LIVE_STREAM_RELAYS = sanitizeRelays([
  ...DEFAULT_RELAYS,
  'wss://relay.zap.stream',
  'wss://nostr.wine',
]);

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

  // NIP-53 zap splits: ["zap", "<pubkey>", "<relay>", "<weight>"]
  const zapWeights = event.tags
    .filter((t) => t[0] === 'zap' && typeof t[1] === 'string' && t[1].length === 64)
    .map((t) => ({
      pubkey: t[1],
      relay: t[2] || undefined,
      weight: parseFloat(t[3] ?? '1') || 1,
    }));

  return {
    id: `${event.pubkey}:${dTag}`,
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

      return Array.from(byAddr.values())
        .map(parseNostrLiveStream)
        .filter((s) => s.status === 'live' || s.status === 'planned')
        .sort((a, b) => {
          if (a.status !== b.status) return a.status === 'live' ? -1 : 1;
          return (a.startsAt ?? 0) - (b.startsAt ?? 0);
        });
    } catch {
      return [];
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
  // Build the candidate list: zap-split participants, or host as fallback
  const candidates: Array<{ pubkey: string; relay?: string; weight: number }> =
    stream.zapWeights.length
      ? stream.zapWeights
      : [{ pubkey: stream.pubkey, weight: 1 }];

  const results = await Promise.all(
    candidates.map(async ({ pubkey, relay, weight }) => {
      const cached = storage.profile.get(pubkey);
      let profile: ProfileMetadata | null | undefined = cached;
      if (profile === undefined) {
        // Not cached — fetch. Skip known misses (cached === null).
        const relays = relay ? sanitizeRelays([relay, ...DEFAULT_RELAYS]) : DEFAULT_RELAYS;
        profile = await fetchProfile(pubkey, relays);
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
