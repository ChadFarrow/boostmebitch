// NIP-07 sign-in + boost note publishing.
// Replace with v4v-toolkit's nostr helpers when ready.

import { nip19, SimplePool, type Event, type EventTemplate } from 'nostr-tools';
import type { Boostagram, Episode, Podcast, BoostResult } from './types';

declare global {
  interface Window {
    nostr?: {
      getPublicKey: () => Promise<string>;
      signEvent: (e: EventTemplate) => Promise<Event>;
      nip04?: {
        encrypt: (pubkey: string, plaintext: string) => Promise<string>;
        decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
      };
    };
    webln?: {
      enable: () => Promise<void>;
      sendPayment: (invoice: string) => Promise<{ preimage: string }>;
      keysend?: (args: {
        destination: string;
        amount: number;
        customRecords?: Record<string, string>;
      }) => Promise<{ preimage: string }>;
      lnurl?: (lnurl: string) => Promise<any>;
    };
  }
}

export interface ProfileMetadata {
  name?: string;
  display_name?: string;
  picture?: string;
  nip05?: string;
  about?: string;
}

export interface NostrIdentity {
  pubkey: string;        // hex
  npub: string;          // bech32
  profile?: ProfileMetadata;
  writeRelays?: string[]; // from NIP-65 kind:10002 (write or unmarked entries)
}

// ── Login ────────────────────────────────────────────────────────────────────

export async function loginWithExtension(): Promise<NostrIdentity> {
  if (typeof window === 'undefined' || !window.nostr) {
    throw new Error(
      'No Nostr signer found. Install Alby, nos2x, or another NIP-07 extension.',
    );
  }
  const pubkey = await window.nostr.getPublicKey();
  return { pubkey, npub: nip19.npubEncode(pubkey) };
}

export function shortNpub(npub: string, len = 8) {
  if (npub.length <= len * 2 + 1) return npub;
  return `${npub.slice(0, len)}…${npub.slice(-len)}`;
}

// ── Relays ───────────────────────────────────────────────────────────────────

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

const RELAYS_KEY = 'bmb:relays';

// ── Pool lifecycle helper ────────────────────────────────────────────────────
// Wraps `new SimplePool()` + `pool.close()` so callers can't forget the
// teardown. Used for every kind:0 / 10002 / 30003 query and every publish.

async function withPool<T>(
  relays: string[],
  fn: (pool: SimplePool) => Promise<T>,
): Promise<T> {
  const pool = new SimplePool();
  try {
    return await fn(pool);
  } finally {
    pool.close(relays);
  }
}

// ── Profile metadata (kind:0) ────────────────────────────────────────────────

export async function fetchProfile(
  pubkey: string,
  relays?: string[],
): Promise<ProfileMetadata | null> {
  const useRelays = relays ?? DEFAULT_RELAYS;
  return withPool(useRelays, async (pool) => {
    try {
      const events = await pool.querySync(useRelays, {
        kinds: [0],
        authors: [pubkey],
        limit: 1,
      });
      if (!events.length) return null;
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
      return JSON.parse(newest.content) as ProfileMetadata;
    } catch {
      return null;
    }
  });
}

// ── NIP-65 relay list (kind:10002) ───────────────────────────────────────────
// We only need the write side — we never read events from arbitrary relays
// based on someone's read list. Drop `read` from the parser and the type.

export async function fetchRelayList(
  pubkey: string,
  queryRelays?: string[],
): Promise<{ write: string[] } | null> {
  const useRelays = queryRelays ?? DEFAULT_RELAYS;
  return withPool(useRelays, async (pool) => {
    try {
      const events = await pool.querySync(useRelays, {
        kinds: [10002],
        authors: [pubkey],
        limit: 1,
      });
      if (!events.length) return null;
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
      const write = new Set<string>();
      for (const tag of newest.tags) {
        if (tag[0] !== 'r' || !tag[1]) continue;
        const url = tag[1].trim().replace(/\/$/, '');
        if (!url) continue;
        const marker = tag[2];
        if (!marker || marker === 'write') write.add(url);
      }
      return { write: Array.from(write) };
    } catch {
      return null;
    }
  });
}

/**
 * Effective relay set for publishing the user's events.
 * Priority: explicit localStorage override → identity NIP-65 write relays → DEFAULT_RELAYS.
 * Capped at 20 to keep publish latency bounded.
 */
export function resolvePublishRelays(identity: NostrIdentity | null): string[] {
  if (typeof window !== 'undefined') {
    const raw = localStorage.getItem(RELAYS_KEY);
    if (raw) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) return arr.slice(0, 20);
      } catch { /* fall through */ }
    }
  }
  if (identity?.writeRelays?.length) return identity.writeRelays.slice(0, 20);
  return DEFAULT_RELAYS;
}

// ── Boost note publish ───────────────────────────────────────────────────────

export interface PublishedNote {
  id: string;
  nevent: string;        // bech32 nevent for shareable link
  acceptedRelays: string[];
  failedRelays: string[];
}

interface PublishArgs {
  podcast: Podcast;
  episode?: Episode;        // omit for show-level boosts
  boostagram: Boostagram;
  results: BoostResult[];
  relays?: string[];
  /** Override the note body. Otherwise we auto-format. */
  contentOverride?: string;
}

/**
 * Best public landing page for a podcast, in preference order:
 *  1. pod.link smart-link by Apple iTunes ID — auto-routes the visitor to
 *     their preferred podcast app on click
 *  2. Podcast Index page — human-readable feed metadata
 *  3. raw RSS feed URL
 */
function podcastLandingUrl(podcast: Podcast): string | null {
  if (podcast.itunesId) return `https://pod.link/${podcast.itunesId}`;
  if (podcast.id) return `https://podcastindex.org/podcast/${podcast.id}`;
  return podcast.url ?? null;
}

function formatContent(args: PublishArgs): string {
  const { podcast, episode, boostagram } = args;
  const totalSats = Math.round((boostagram.value_msat_total ?? 0) / 1000);

  const lines: string[] = ['⚡ Boost ⚡', ''];
  if (boostagram.message?.trim()) {
    lines.push(boostagram.message.trim(), '');
  }
  lines.push(`Boosted ${totalSats} sats → ${podcast.title}`);
  if (episode?.title) lines.push(`📻 ${episode.title}`);
  const link = podcastLandingUrl(podcast);
  if (link) lines.push('', link);
  return lines.join('\n');
}

// Sign + publish a single event template across the given relays. Used by
// both publishBoostNote (kind:1) and publishFavorites (kind:30003).
async function signAndPublish(
  template: EventTemplate,
  relays: string[],
): Promise<PublishedNote> {
  if (typeof window === 'undefined' || !window.nostr) {
    throw new Error('No Nostr signer available');
  }
  const signed = await window.nostr.signEvent(template);

  return withPool(relays, async (pool) => {
    const accepted: string[] = [];
    const failed: string[] = [];
    const publishes = pool.publish(relays, signed);
    await Promise.allSettled(
      publishes.map((p, i) =>
        p
          .then(() => accepted.push(relays[i]))
          .catch(() => failed.push(relays[i])),
      ),
    );
    return {
      id: signed.id,
      nevent: nip19.neventEncode({ id: signed.id, relays: accepted.slice(0, 3) }),
      acceptedRelays: accepted,
      failedRelays: failed,
    };
  });
}

export async function publishBoostNote(
  args: PublishArgs,
): Promise<PublishedNote> {
  const { podcast, episode, boostagram, results } = args;
  const relays = args.relays ?? DEFAULT_RELAYS;
  const totalMsat =
    boostagram.value_msat_total ??
    results.reduce((sum, r) => sum + r.sats * 1000, 0);

  // NIP-73 external content tags + boost-specific metadata
  const tags: string[][] = [];
  if (podcast.podcastGuid) {
    tags.push(['i', `podcast:guid:${podcast.podcastGuid}`]);
    tags.push(['k', 'podcast:guid']);
  }
  if (episode?.guid) {
    tags.push(['i', `podcast:item:guid:${episode.guid}`]);
    tags.push(['k', 'podcast:item:guid']);
  }
  const linkUrl = podcastLandingUrl(podcast);
  if (linkUrl) tags.push(['r', linkUrl]);
  if (totalMsat > 0) tags.push(['amount', String(totalMsat)]);
  tags.push(['client', boostagram.app_name ?? 'BoostMeBitch']);
  tags.push(['t', 'boostagram']);
  tags.push(['t', 'value4value']);

  const template: EventTemplate = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: args.contentOverride ?? formatContent(args),
  };

  return signAndPublish(template, relays);
}

// ── NIP-51 favorites (kind:30003 bookmark set) ───────────────────────────────

export const FAVORITES_D_TAG = 'boostmebitch:favorites';

export interface FavoritesEvent {
  guids: string[];
  updatedAt: number; // unix seconds, from event.created_at
}

export async function fetchFavoriteGuids(
  pubkey: string,
  queryRelays?: string[],
): Promise<FavoritesEvent | null> {
  const useRelays = queryRelays ?? DEFAULT_RELAYS;
  return withPool(useRelays, async (pool) => {
    try {
      const events = await pool.querySync(useRelays, {
        kinds: [30003],
        authors: [pubkey],
        '#d': [FAVORITES_D_TAG],
        limit: 1,
      });
      if (!events.length) return null;
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
      const guids: string[] = [];
      for (const tag of newest.tags) {
        if (tag[0] !== 'i' || !tag[1]) continue;
        const m = /^podcast:guid:(.+)$/.exec(tag[1]);
        if (m) guids.push(m[1]);
      }
      return { guids, updatedAt: newest.created_at };
    } catch {
      return null;
    }
  });
}

export async function publishFavorites(
  guids: string[],
  relays: string[],
): Promise<PublishedNote> {
  const tags: string[][] = [
    ['d', FAVORITES_D_TAG],
    ['title', 'Favorite Podcasts'],
  ];
  for (const guid of guids) {
    tags.push(['i', `podcast:guid:${guid}`]);
    tags.push(['k', 'podcast:guid']);
  }
  const template: EventTemplate = {
    kind: 30003,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
  return signAndPublish(template, relays);
}

// Debounced wrapper — collapses rapid heart-toggles into a single signing prompt.
let publishFavoritesTimer: ReturnType<typeof setTimeout> | null = null;
export function schedulePublishFavorites(
  getGuids: () => string[],
  relays: string[],
  delayMs = 1500,
) {
  if (publishFavoritesTimer) clearTimeout(publishFavoritesTimer);
  publishFavoritesTimer = setTimeout(() => {
    publishFavoritesTimer = null;
    publishFavorites(getGuids(), relays).catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[favorites] publish failed:', e?.message ?? e);
    });
  }, delayMs);
}
