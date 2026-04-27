// Podcasting 2.0 value block types — mirrors the spec, not Podcast Index's exact JSON shape

export interface ValueRecipient {
  name?: string;
  type: 'node' | 'lnaddress' | string;
  address: string;        // node pubkey for keysend, ln-addr for lnaddress
  customKey?: string;
  customValue?: string;
  split: number;          // weight, not percent
  fee?: boolean;
}

export interface ValueBlock {
  type: 'lightning' | string;
  method: 'keysend' | 'lnaddress' | string;
  suggested?: string;     // BTC, e.g. "0.00000005000"
  recipients: ValueRecipient[];
}

export interface Podcast {
  id: number;
  podcastGuid?: string;   // namespace UUID for NIP-73 podcast:guid:
  title: string;
  author?: string;
  description?: string;
  image?: string;
  url?: string;           // RSS feed URL
  value?: ValueBlock | null;
}

export interface Episode {
  id: number;
  guid?: string;          // episode GUID for NIP-73 podcast:item:guid:
  title: string;
  description?: string;
  enclosureUrl: string;
  enclosureType?: string;
  duration?: number;
  datePublished?: number;
  image?: string;
  feedId: number;
  feedTitle?: string;
  feedImage?: string;
  podcastGuid?: string;
  value?: ValueBlock | null;
}

export interface Boostagram {
  app_name: string;
  app_version?: string;
  podcast?: string;
  episode?: string;
  feedID?: number;
  itemID?: number;
  url?: string;
  ts?: number;            // playback timestamp in seconds
  value_msat?: number;    // per-leg amount in msats (set per recipient in v4v/boost.ts)
  value_msat_total?: number; // total boost amount in msats (same on every leg)
  message?: string;
  sender_name?: string;
  sender_id?: string;     // nostr pubkey if signed in
  action: 'boost' | 'stream' | 'auto';
  name?: string;             // recipient name, set per leg in lib/v4v/boost.ts
  uuid?: string;             // unique boost ID — shared across all legs
  remote_feed_guid?: string; // RSS <podcast:guid> (NIP-73)
  episode_guid?: string;     // RSS item <guid>
  remote_item_guid?: string; // duplicate of episode_guid for aggregator compat
}

export interface BoostResult {
  recipient: ValueRecipient;
  sats: number;
  ok: boolean;
  preimage?: string;
  error?: string;
}

export interface FavoritePodcast {
  id: number;             // Podcast Index feed ID
  podcastGuid: string;    // canonical NIP-73 identifier (key)
  title: string;
  author?: string;
  image?: string;
  url?: string;           // RSS feed URL
  addedAt: number;        // unix ms — used for sort + last-write-wins merge
}
