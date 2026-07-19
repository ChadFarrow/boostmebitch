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

export interface ValueTimeSplitRemoteItem {
  feedGuid: string;
  itemGuid?: string;
  medium?: string;
}

export interface ValueTimeSplit {
  startTime: number;
  duration: number;
  remoteStartTime?: number;
  remotePercentage?: number;   // % of sats going to remoteItem (rest goes to episode value block)
  remoteItem?: ValueTimeSplitRemoteItem;
  // Populated by /api/value-splits after resolution:
  value?: ValueBlock | null;
  title?: string;
  image?: string;
  feedId?: number;
  episodeGuid?: string;
}

// A single <podcast:funding> entry — a host's non-Lightning support link
// (Patreon, Buy Me a Coffee, etc.). `message` is the tag's text content, shown
// as a label/tooltip. Channel-scoped; PI indexes one, RSS may carry several.
export interface FundingLink {
  url: string;
  message?: string;
}

// A single <podcast:podroll> entry — another show the host recommends.
// Channel-scoped remote item (feedGuid/feedUrl, no itemGuid). Resolved to a
// full Podcast client-side via resolvePodcastByGuid.
export interface PodrollItem {
  feedGuid: string;
  feedUrl?: string;
}

export interface Podcast {
  id: number;
  podcastGuid?: string;   // namespace UUID for NIP-73 podcast:guid:
  itunesId?: number;      // Apple Podcasts ID — used by pod.link smart-links
  title: string;
  author?: string;
  description?: string;
  /** RSS channel <image><url>. Often the publisher's preferred art but may
   *  404 when self-hosted on a since-broken domain. */
  image?: string;
  /** RSS <itunes:image>, mirrored by PI under `artwork`. Tried as a
   *  second-chance source when `image` fails to load. */
  artwork?: string;
  url?: string;           // RSS feed URL
  medium?: string;        // podcast:medium (e.g. 'music', 'publisher')
  value?: ValueBlock | null;
  podroll?: PodrollItem[]; // <podcast:podroll> — host-recommended shows (from RSS)
  funding?: FundingLink[]; // <podcast:funding> — non-Lightning support links
}

export interface SocialInteract {
  uri: string;          // nostr: URI (note1, nevent1)
  accountId?: string;   // npub of the account that posted it
  priority?: number;
}

export interface Episode {
  id: number;
  guid?: string;          // episode GUID for NIP-73 podcast:item:guid:
  title: string;
  description?: string;
  contentEncoded?: string; // Sanitized HTML from RSS <content:encoded> — full show notes
  link?: string;          // Episode web page (RSS <link> / PI `link`) — full notes live here
  enclosureUrl: string;
  enclosureType?: string;
  duration?: number;
  datePublished?: number;
  image?: string;
  feedId: number;
  feedTitle?: string;
  feedImage?: string;
  podcastGuid?: string;
  episode?: number | null;     // <podcast:episode> / <itunes:episode> if present
  season?: number | null;      // <podcast:season> if present (disc number for music)
  chaptersUrl?: string;        // PI exposes Podcasting 2.0 chapters JSON URL
  /** Chosen <podcast:transcript> URL — the best *timed* transcript for this
   *  episode (JSON > SRT > VTT), fetched + parsed client-side by lib/transcript.ts. */
  transcriptUrl?: string;
  /** MIME type of `transcriptUrl` so the parser knows the format. */
  transcriptType?: string;
  value?: ValueBlock | null;
  valueTimeSplits?: ValueTimeSplit[];
  socialInteract?: SocialInteract[];
  /** Podcast 2.0 <podcast:liveItem> status. Set on items returned by PI's
   *  /episodes/live endpoint. We filter out 'ended' upstream, so only
   *  'live' and 'pending' should ever reach the client. */
  liveStatus?: 'pending' | 'live' | 'ended';
  /** Scheduled start, unix seconds. */
  liveStartTime?: number;
  /** Nostr live streams only: the actual host's pubkey — the NIP-53 `p` tag
   *  with role "host", falling back to the event author. Platform-published
   *  streams (Shosho, zap.stream) are authored by the PLATFORM's key, so the
   *  `/live/<npub>` share link must be built from this, not from the stream
   *  id's author half. */
  liveHostPubkey?: string;
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
  // Set on LNURL legs when BoostBox accepted the metadata. The URL is the
  // public landing page; the id is the last path segment.
  boostboxUrl?: string;
  boostboxId?: string;
}

/**
 * One sent boost, captured locally for the "My Boosts" panel. Indexed by uuid.
 * Stored in `bmb:boosts:<npub>` (or `:guest` when signed out).
 */
export interface StoredBoost {
  uuid: string;
  ts: number;                  // unix ms — when the user confirmed
  podcastTitle: string;
  podcastId?: number;
  podcastGuid?: string;
  podcastImage?: string;
  episodeTitle?: string;
  episodeGuid?: string;
  sats: number;                // intent total, in sats
  message?: string;
  senderName?: string;
  noteId?: string;             // nostr event id of the boost note, if published
  legs: StoredBoostLeg[];
}

export interface StoredBoostLeg {
  recipient: string;           // node pubkey or lightning address
  recipientName?: string;
  sats: number;
  ok: boolean;
  error?: string;
  boostboxUrl?: string;         // present on LNURL legs when BoostBox accepted
}

export interface FavoritePodcast {
  id: number;             // Podcast Index feed ID
  podcastGuid: string;    // canonical NIP-73 identifier (key)
  title: string;
  author?: string;
  image?: string;
  /** Mirror of Podcast.artwork — second-chance source when `image` 404s. */
  artwork?: string;
  url?: string;           // RSS feed URL
  addedAt: number;        // unix ms — used for sort + last-write-wins merge
}
