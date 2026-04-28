import { nip19, type Event } from 'nostr-tools';
import { withPool } from './pool';
import { DISCOVERY_RELAYS } from './relays';
import type { ProfileMetadata } from './auth';

export interface DiscoveredNote {
  id: string;
  pubkey: string;
  npub: string;
  nevent: string;          // bech32-encoded for client deep-links (njump.me/<nevent>)
  createdAt: number;       // unix seconds
  content: string;
  amountMsat: number | null;
  client: string | null;
  isBoost: boolean;        // `t:boostagram` tag OR a positive `amount` tag
  podcastGuid: string | null; // first podcast:guid: ref on the note (the show)
  episodeGuids: string[];  // any podcast:item:guid: refs on the note
  author: ProfileMetadata | null;
  rawEvent: Event;         // signed source event — needed to thread replies and to embed in NIP-18 reposts
}

interface FetchOpts {
  relays?: string[];
  /** Cap on raw kind:1 events fetched; default 100. */
  limit?: number;
}

function buildNote(e: Event, relays: string[], profile: ProfileMetadata | null): DiscoveredNote {
  const amountTag = e.tags.find((t) => t[0] === 'amount')?.[1];
  const amountMsat = amountTag ? Number(amountTag) : null;
  const client = e.tags.find((t) => t[0] === 'client')?.[1] ?? null;
  // Different apps tag boosts differently: BoostMeBitch and Helipad-style
  // aggregators emit `t:boostagram`; some clients (Fountain, Wavlake
  // variants) may omit it but still emit a positive `amount` tag. Treat
  // either as a boost so the ⚡ stamp shows up consistently.
  const isBoost =
    e.tags.some((t) => t[0] === 't' && (t[1] === 'boostagram' || t[1] === 'value4value')) ||
    (Number.isFinite(amountMsat) && (amountMsat ?? 0) > 0);
  const podcastGuid =
    e.tags
      .find((t) => t[0] === 'i' && t[1]?.startsWith('podcast:guid:'))
      ?.[1]
      ?.slice('podcast:guid:'.length) ?? null;
  const episodeGuids = e.tags
    .filter((t) => t[0] === 'i' && t[1]?.startsWith('podcast:item:guid:'))
    .map((t) => t[1].slice('podcast:item:guid:'.length));
  return {
    id: e.id,
    pubkey: e.pubkey,
    npub: nip19.npubEncode(e.pubkey),
    nevent: nip19.neventEncode({
      id: e.id,
      relays: relays.slice(0, 3),
      author: e.pubkey,
    }),
    createdAt: e.created_at,
    content: e.content,
    amountMsat: Number.isFinite(amountMsat) ? amountMsat : null,
    client,
    isBoost,
    podcastGuid,
    episodeGuids,
    author: profile,
    rawEvent: e,
  };
}

/**
 * Fetch every kind:1 note tagged with NIP-73 `podcast:guid:<podcastGuid>` from
 * the given relays. Resolves each unique author's kind:0 metadata in a single
 * follow-up query so the UI can render avatar + display_name without N+1
 * round-trips. Returns notes sorted newest-first, deduped by event id.
 */
export async function fetchPodcastNotes(
  podcastGuid: string,
  opts: FetchOpts = {},
): Promise<DiscoveredNote[]> {
  const relays = opts.relays ?? DISCOVERY_RELAYS;
  const limit = opts.limit ?? 100;

  return withPool(relays, async (pool) => {
    let events: Event[] = [];
    try {
      events = await pool.querySync(relays, {
        kinds: [1],
        '#i': [`podcast:guid:${podcastGuid}`],
        limit,
      });
    } catch {
      return [];
    }
    return await assembleNotes(pool, relays, events);
  });
}

/**
 * Fetch the global stream of every kind:1 note tagged with NIP-73 podcast
 * identifiers across ALL podcasts. Filters by `#k: ['podcast:guid',
 * 'podcast:item:guid']` so any client that follows the Podcasting 2.0 NIP-73
 * convention is included regardless of which show.
 */
export async function fetchAllPodcastNotes(
  opts: FetchOpts = {},
): Promise<DiscoveredNote[]> {
  const relays = opts.relays ?? DISCOVERY_RELAYS;
  const limit = opts.limit ?? 100;

  return withPool(relays, async (pool) => {
    let events: Event[] = [];
    try {
      events = await pool.querySync(relays, {
        kinds: [1],
        '#k': ['podcast:guid', 'podcast:item:guid'],
        limit,
      });
    } catch {
      return [];
    }
    return await assembleNotes(pool, relays, events);
  });
}

async function assembleNotes(
  pool: import('nostr-tools').SimplePool,
  relays: string[],
  events: Event[],
): Promise<DiscoveredNote[]> {
  if (!events.length) return [];

  // Dedupe by id (relays often return overlapping copies) and sort newest first.
  const byId = new Map<string, Event>();
  for (const e of events) byId.set(e.id, e);
  const unique = Array.from(byId.values()).sort(
    (a, b) => b.created_at - a.created_at,
  );

  const authors = Array.from(new Set(unique.map((e) => e.pubkey)));
  const profiles = await fetchProfiles(pool, relays, authors);

  return unique.map((e) => buildNote(e, relays, profiles.get(e.pubkey) ?? null));
}

async function fetchProfiles(
  pool: import('nostr-tools').SimplePool,
  relays: string[],
  authors: string[],
): Promise<Map<string, ProfileMetadata>> {
  const out = new Map<string, ProfileMetadata>();
  if (!authors.length) return out;
  let events: Event[] = [];
  try {
    events = await pool.querySync(relays, {
      kinds: [0],
      authors,
    });
  } catch {
    return out;
  }
  // Newest kind:0 wins per pubkey.
  const newest = new Map<string, Event>();
  for (const e of events) {
    const prev = newest.get(e.pubkey);
    if (!prev || e.created_at > prev.created_at) newest.set(e.pubkey, e);
  }
  for (const [pubkey, e] of newest) {
    try {
      out.set(pubkey, JSON.parse(e.content) as ProfileMetadata);
    } catch {
      // ignore unparseable content
    }
  }
  return out;
}
