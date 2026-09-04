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
  /** The remote item's PARENT FEED title — the album the track belongs to, not
   *  the show playing it. Carried so a track favorite can record it:
   *  `<FavTrackHeart>` writes a `FavoriteEpisode` whose `podcastTitle` is this,
   *  and without it a freshly-favorited track sits on the favorites list with no
   *  album name until Podcast Index re-resolves it on some later load. */
  feedTitle?: string;
  /**
   * The ARTIST — the parent feed's `author`, and display-only.
   *
   * Podcast Index carries it on the FEED record and not on the episode one, so
   * it costs a second lookup and is filled in only where a surface names the
   * song to a person: `<LivePlayedTracks>` today. A block's own `title` is the
   * track, `feedTitle` is the album, and neither of them answers "who is this?"
   * — a single-track album feed titles itself after the song, so on the live
   * played list every row read as a bare track name with nothing saying whose
   * it was.
   *
   * **Nothing may key off it or pay it.** It is a string a feed wrote about
   * itself; the payees are `value.recipients` and the identity of the track is
   * `remoteItem`. Absent whenever the lookup missed, failed, or was never made,
   * which is ordinary — a surface renders what it has and says nothing more.
   */
  artist?: string;
  episodeGuid?: string;
  /**
   * The feed guid that actually CONTAINS this track, when resolution learned
   * that `remoteItem.feedGuid` isn't it. Three states, and all three are load-
   * bearing for `<FavTrackHeart>`:
   *
   *   - `undefined` — nothing learned. Fall back to `remoteItem.feedGuid`; a
   *     favorite recorded against it may be a placeholder until Podcast Index
   *     crawls the item, which is ordinary and self-healing.
   *   - a string — the real album guid, recovered by walking a publisher feed.
   *     Use it in place of `remoteItem.feedGuid`.
   *   - `null` — the host's `feedGuid` points at a PUBLISHER feed and the album
   *     it led to declares no guid of its own. There is no resolvable parent to
   *     record, so no favorite may be offered: `/episodes/byguid` needs a real
   *     `podcastguid`, and a favorite published to the shared kind:10333 list
   *     without one can never be opened, here or in any other app. Same rule
   *     `<FavEpisodeHeart>` already applies to an episode with no parent feed.
   */
  parentFeedGuid?: string | null;
}

/**
 * One entry from a Podcasting 2.0 `<podcast:chapters>` JSON file.
 *
 * **It lives here rather than in `lib/chapters.ts` so `lib/util.ts` can name
 * it.** `mergeEpisodeContents` interleaves chapters with `ValueTimeSplit`
 * windows, and `lib/chapters.ts` is a `'use client'` module that already
 * imports `isMusicMedium` from `lib/util.ts` — importing back would be a cycle,
 * and would put a React module on the import graph of the one file that has to
 * stay loadable under `node --experimental-strip-types` for `check:vts`.
 * `lib/chapters.ts` re-exports it, so every existing import site is unchanged.
 */
export interface ChapterEntry {
  startTime: number;
  title?: string;
  img?: string;   // per-chapter artwork (Podcasting 2.0 chapters `img`)
  url?: string;   // per-chapter external link (chapters `url`)
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

// A Nostr identity a feed declares for itself via
// <podcast:txt purpose="nostr">npub1…</podcast:txt> — the show/artist at channel
// level, a specific track's artist at item level. Both forms are carried so
// consumers never have to re-decode: `npub` is what a note body mentions,
// `pubkey` is the hex a NIP-01 `p` tag needs. Validated at parse time in
// lib/pi.ts (nip19.decode), so a value that reaches here is a real npub.
export interface FeedNpub {
  npub: string;
  pubkey: string;
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
  nostrNpubs?: FeedNpub[]; // <podcast:txt purpose="nostr"> — the show's own npub(s), from RSS
  /** Synthetic feed parsed directly from raw RSS because it isn't in Podcast
   *  Index — a preview so a publisher can see how a test feed displays before
   *  submitting it to PI. Carries a negative `id` (`-fnvHash(url)`) and no
   *  `podcastGuid`, which disables favorite/share/Nostr and URL mirroring. */
  isPreview?: boolean;
}

export interface SocialInteract {
  uri: string;          // nostr: URI (note1, nevent1)
  accountId?: string;   // npub of the account that posted it
  priority?: number;
}

// A Podcasting 2.0 <podcast:alternateEnclosure> — an alternate rendition of the
// same episode (e.g. a video version, or a different bitrate/codec). Each block
// carries one or more <podcast:source uri> mirrors; we keep the first usable
// source. Used to offer a "Video" playback option alongside the audio enclosure.
export interface AlternateEnclosure {
  /** MIME type from the `type` attr, e.g. "video/mp4" or "audio/mpeg". */
  type?: string;
  /** Human label from the `title` attr, e.g. "Video". */
  title?: string;
  /** Chosen media URL — the first `<podcast:source uri>` (mirror). */
  source: string;
  /** Byte length from the `length` attr, if present. */
  length?: number;
  /** Bitrate (bits/s) from the `bitrate` attr, if present. */
  bitrate?: number;
  /** Pixel height for video variants (`height` attr), if present. */
  height?: number;
  /** `default="true"` — the publisher's preferred rendition. */
  default?: boolean;
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
  /** Podcasting 2.0 <podcast:alternateEnclosure> renditions (e.g. a video
   *  version). Parsed from RSS — PI doesn't index the tag. */
  alternateEnclosures?: AlternateEnclosure[];
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
  /**
   * Set ONLY on a placeholder row standing in for a `musicL` playlist track
   * that could not be turned into a real episode. The two values are not
   * interchangeable and must never be collapsed — see lib/pi-batch.ts:
   *
   *   'not-found'      Podcast Index answered, and does not hold this track.
   *                    A settled answer, cacheable, and the row says so.
   *   'could-not-ask'  We never got an answer (PI down, our own rate limit).
   *                    NOT evidence about the track: the response carrying one
   *                    of these is `no-store` and the row offers a retry.
   *
   * A row carrying this has an empty `enclosureUrl`, so every play control must
   * be suppressed rather than merely disabled.
   */
  unresolved?: 'not-found' | 'could-not-ask';
  /**
   * The `<podcast:txt purpose="episode">` caption this row sat under in a
   * playlist, when the feed published one. A HEADING, not an identifier: it is
   * free text the playlist author wrote, it is not unique, and nothing may key
   * off it. Absent on every non-playlist row, and on playlists that publish no
   * markers (the LocalBitcoiners list publishes none; Greatest Hits publishes
   * play counts instead — see `playlistPlays`).
   *
   * It rides on the row rather than in a separate groups array so that a page
   * appended by "load more" carries its own captions — the heading logic is then
   * a comparison with the previous row and works across page boundaries with no
   * extra state to keep in sync.
   */
  playlistGroup?: string;
  /**
   * The `<podcast:txt purpose="playcount">` marker this row sat under in a
   * playlist — how many times the curator's shows played the track. The
   * Greatest Hits list is ordered by it, and every row prints it. A number
   * parsed off the marker, never its text (`PlaylistItemRef.plays`); absent on
   * every non-playlist row and on playlists that publish no such marker. Rides
   * on the row for the same "load more" reason `playlistGroup` does.
   */
  playlistPlays?: number;
  /** Podcast 2.0 <podcast:liveItem> status. Set on items returned by PI's
   *  /episodes/live endpoint. We filter out 'ended' upstream, so only
   *  'live' and 'pending' should ever reach the client. */
  liveStatus?: 'pending' | 'live' | 'ended';
  /** Scheduled start, unix seconds. */
  liveStartTime?: number;
  /** `<podcast:liveValue uri protocol>` inside the live item — a push channel
   *  the show broadcasts its current payment target on. This is what The Split
   *  Kit publishes, and it is how the live V4V music shows actually switch
   *  wallets; the RSS-rewriting signals below are the fallback. `uri` has
   *  already been through `httpUrl`. */
  liveValue?: { uri: string; protocol: string };
  /** A <podcast:remoteItem> published INSIDE this <podcast:liveItem> — the
   *  "now playing" pointer a live music show rewrites per track. There is no
   *  live valueTimeSplit tag (a live stream has no absolute time base to sync
   *  to); updating the live item is the convention that actually ships. */
  liveRemoteItem?: ValueTimeSplitRemoteItem;
  /** <podcast:valueTimeSplit> children found inside this live item. Kept
   *  separate from `valueTimeSplits` because their startTime/duration are
   *  meaningless for a live stream — only a lone entry is interpretable, as
   *  "now playing". See resolveLiveSplit. */
  liveValueTimeSplits?: ValueTimeSplit[];
  /** Nostr live streams only: the actual host's pubkey — the NIP-53 `p` tag
   *  with role "host", falling back to the event author. Platform-published
   *  streams (Shosho, zap.stream) are authored by the PLATFORM's key, so the
   *  `/live/<npub>` share link must be built from this, not from the stream
   *  id's author half. */
  liveHostPubkey?: string;
  /** <podcast:txt purpose="nostr"> published inside this <item> — the track's
   *  or episode's own artist, distinct from the channel-level show npub. Both
   *  are tagged on a boost note; see lib/nostr/boost-notes.ts. */
  nostrNpubs?: FeedNpub[];
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
  /** Where the recipient may send a reply boost back to. **Either a node
   *  pubkey or a lightning address** — the receiver tells them apart by the
   *  `@`, and resolves an address itself. `reply_custom_key` /
   *  `reply_custom_value` are the sub-account routing pair for a shared
   *  custodial node and go on the wire together or not at all; the key is a
   *  record NUMBER, because a receiver reading it as an integer treats a
   *  quoted one as absent and rejects the reply. All three are built by
   *  `replyFieldsFor` (lib/v4v/keysend-lookup.ts) and dropped entirely on an
   *  anonymous boost, like `sender_id` — a lightning address names its
   *  owner. */
  reply_address?: string;
  reply_custom_key?: number;
  reply_custom_value?: string;
  action: 'boost' | 'stream' | 'auto';
  name?: string;             // recipient name, set per leg in lib/v4v/boost.ts
  uuid?: string;             // unique boost ID — shared across all legs
  remote_feed_guid?: string; // RSS <podcast:guid> (NIP-73)
  episode_guid?: string;     // RSS item <guid>
  remote_item_guid?: string; // duplicate of episode_guid for aggregator compat
  /** The Split Kit's own correlation ids, echoed back when a live show's
   *  payment target came off its `<podcast:liveValue>` channel. Split Kit ties
   *  a payment to the block that earned it through these; the standard
   *  `remote_*_guid` fields above still carry the track, so nothing here
   *  replaces them. */
  eventGuid?: string;
  blockGuid?: string;
  eventAPI?: string;
}

export interface BoostResult {
  recipient: ValueRecipient;
  sats: number;
  ok: boolean;
  /**
   * The leg neither succeeded nor provably failed — the wallet was asked and
   * never answered (see NwcIndeterminateError). `ok` is false because we have
   * no preimage, but the sats may well have gone out, so nothing may present
   * this as a failure and nothing may retry it.
   */
  indeterminate?: boolean;
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
  /** See BoostResult.indeterminate — the log must not claim a failure either. */
  indeterminate?: boolean;
  error?: string;
  boostboxUrl?: string;         // present on LNURL legs when BoostBox accepted
}

/**
 * A favorited show.
 *
 * **The favorite IS `podcastGuid`; everything else is display cache.** That
 * split is load-bearing, not stylistic: the store is what
 * `localFavoriteEntries()` publishes from, so an entry that Podcast Index
 * couldn't resolve must still hold a row here. Dropping it instead used to
 * prune the store, and because the baseline was recorded from the *pre-prune*
 * set, the next page load read every unresolved entry as a local removal and
 * published the deletion to a list other apps read. One PI outage, one reload.
 *
 * So `title` and a real `id` are optional-by-absence, and a row without them
 * renders as unresolved rather than vanishing — which is also what the spec
 * asks for ("keep it on the list, keep republishing it, and render it as
 * unresolved").
 */
export interface FavoritePodcast {
  /** Podcast Index feed ID. 0 until this device resolves one. */
  id: number;
  podcastGuid: string;    // canonical NIP-73 identifier (key)
  /** Absent until PI resolves the guid — never a reason to drop the favorite. */
  title?: string;
  author?: string;
  image?: string;
  /** Mirror of Podcast.artwork — second-chance source when `image` 404s. */
  artwork?: string;
  url?: string;           // RSS feed URL
  /**
   * `<podcast:medium>` — what the FEED declared, never what this app's UI
   * concluded. Resolved from Podcast Index where we have it, otherwise the
   * position-4 hint another app left on the wire.
   *
   * **Absent means "not known", which is not the same as `podcast`.** The list
   * carries podcasts and music at once by design, so whichever way you default
   * you are wrong about half of it — unknown is its own bucket everywhere it
   * is rendered.
   */
  medium?: string;
  /** unix ms — used for sort + last-write-wins merge. 0 means "not known yet",
   *  so a first real resolve stamps its own rather than inheriting a
   *  placeholder's; see the resolve merge in favorites-hydrator.ts. */
  addedAt: number;  /**
   * On the list, but NOT this device's to publish.
   *
   * The kind:10333 event has two halves and this app writes into one of them.
   * Entries in the other half that our baseline does not claim are another
   * writer's — or our own, written by an app whose baseline we cannot see. They
   * are still the user's favorites, so they are RENDERED; they are not ours to
   * assert, so `localFavoriteEntries()` skips them and they never enter a tag
   * array this device signs.
   *
   * **Both halves of that sentence are load-bearing.** Dropping them instead —
   * which is what `claimedByBaseline` did before this field existed — hides a
   * user's own favorites from them on the device they just made the choice on,
   * which is the failure the format's own private-half note warns about.
   * Publishing them instead turns a private entry into a plaintext `i` tag on
   * the next cycle, which relays index and which cannot be taken back.
   */
  carried?: boolean;
}

/**
 * A favorited episode. Keyed by `itemGuid` (NIP-73 `podcast:item:guid:`), with
 * `feedGuid` carried alongside because PI's /episodes/byguid wants
 * `podcastguid` — an item guid on its own is not enough to resolve one.
 * Everything after those two is display cache, refreshed on hydration.
 *
 * Same rule as {@link FavoritePodcast}: the favorite is the guid. An entry
 * whose parent feed is unknown is unresolvable, not deletable.
 */
export interface FavoriteEpisode {
  itemGuid: string;       // <guid> of the RSS item — the key
  /** Parent <podcast:guid>. Absent when the wire entry carried no position-3
   *  parent ref, which makes the item unresolvable through PI but still the
   *  user's favorite. */
  feedGuid?: string;
  feedId?: number;        // Podcast Index feed ID, when known
  feedUrl?: string;       // parent RSS feed URL — a legacy position-2 hint
  /** Absent until PI resolves the item. */
  title?: string;
  podcastTitle?: string;
  image?: string;
  enclosureUrl?: string;
  datePublished?: number;
  /** The PARENT FEED's `<podcast:medium>` — Podcasting 2.0 has no per-item
   *  medium. Same "absent means unknown" rule as {@link FavoritePodcast}. */
  medium?: string;
  addedAt: number;        // unix ms — 0 means "not known yet"
  /**
   * On the list, but NOT this device's to publish.
   *
   * The kind:10333 event has two halves and this app writes into one of them.
   * Entries in the other half that our baseline does not claim are another
   * writer's — or our own, written by an app whose baseline we cannot see. They
   * are still the user's favorites, so they are RENDERED; they are not ours to
   * assert, so `localFavoriteEntries()` skips them and they never enter a tag
   * array this device signs.
   *
   * **Both halves of that sentence are load-bearing.** Dropping them instead —
   * which is what `claimedByBaseline` did before this field existed — hides a
   * user's own favorites from them on the device they just made the choice on,
   * which is the failure the format's own private-half note warns about.
   * Publishing them instead turns a private entry into a plaintext `i` tag on
   * the next cycle, which relays index and which cannot be taken back.
   */
  carried?: boolean;
}
