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

const RELAYS_KEY = 'pv4v:relays';

export function loadRelays(): string[] {
  if (typeof window === 'undefined') return DEFAULT_RELAYS;
  const raw = localStorage.getItem(RELAYS_KEY);
  if (!raw) return DEFAULT_RELAYS;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length ? arr : DEFAULT_RELAYS;
  } catch { return DEFAULT_RELAYS; }
}

export function saveRelays(relays: string[]) {
  localStorage.setItem(RELAYS_KEY, JSON.stringify(relays));
}

// ── Profile metadata (kind:0) ────────────────────────────────────────────────

export async function fetchProfile(
  pubkey: string,
  relays?: string[],
): Promise<ProfileMetadata | null> {
  const useRelays = relays ?? loadRelays();
  const pool = new SimplePool();
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
  } finally {
    pool.close(useRelays);
  }
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
  episode: Episode;
  boostagram: Boostagram;
  results: BoostResult[];
  relays?: string[];
  /** Override the note body. Otherwise we auto-format. */
  contentOverride?: string;
}

function formatContent(args: PublishArgs): string {
  const { podcast, episode, boostagram, results } = args;
  const sentSats = results
    .filter((r) => r.ok)
    .reduce((sum, r) => sum + r.sats, 0);
  const totalSats = results.reduce((sum, r) => sum + r.sats, 0);
  const partial = sentSats !== totalSats;

  const lines: string[] = ['⚡ Boost ⚡', ''];
  if (boostagram.message?.trim()) {
    lines.push(boostagram.message.trim(), '');
  }
  const amountLine = partial
    ? `Boosted ${sentSats}/${totalSats} sats`
    : `Boosted ${sentSats} sats`;
  lines.push(`${amountLine} → ${podcast.title}`);
  lines.push(`📻 ${episode.title}`);
  if (podcast.url) lines.push('', podcast.url);
  return lines.join('\n');
}

export async function publishBoostNote(
  args: PublishArgs,
): Promise<PublishedNote> {
  if (typeof window === 'undefined' || !window.nostr) {
    throw new Error('No Nostr signer available');
  }

  const { podcast, episode, boostagram, results } = args;
  const relays = args.relays ?? loadRelays();
  const sentMsat = results
    .filter((r) => r.ok)
    .reduce((sum, r) => sum + r.sats * 1000, 0);

  // NIP-73 external content tags + boost-specific metadata
  const tags: string[][] = [];
  if (podcast.podcastGuid) {
    tags.push(['i', `podcast:guid:${podcast.podcastGuid}`]);
    tags.push(['k', 'podcast:guid']);
  }
  if (episode.guid) {
    tags.push(['i', `podcast:item:guid:${episode.guid}`]);
    tags.push(['k', 'podcast:item:guid']);
  }
  if (podcast.url) tags.push(['r', podcast.url]);
  if (sentMsat > 0) tags.push(['amount', String(sentMsat)]);
  tags.push(['client', boostagram.app_name ?? 'PV4V']);
  tags.push(['t', 'boostagram']);
  tags.push(['t', 'value4value']);

  const template: EventTemplate = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: args.contentOverride ?? formatContent(args),
  };

  const signed = await window.nostr.signEvent(template);

  // Publish to relays. SimplePool returns one promise per relay.
  const pool = new SimplePool();
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

  // Don't keep the pool open — simple fire-and-forget
  pool.close(relays);

  return {
    id: signed.id,
    nevent: nip19.neventEncode({ id: signed.id, relays: accepted.slice(0, 3) }),
    acceptedRelays: accepted,
    failedRelays: failed,
  };
}
