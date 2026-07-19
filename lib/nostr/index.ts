// Barrel re-export so callers can keep using `@/lib/nostr` after the split.
// New code can import from the specific submodule (`@/lib/nostr/favorites`)
// for clearer dependency graphs.

export {
  loginWithExtension,
  loginWithAmber,
  loginWithBunker,
  loginWithNostrConnect,
  restoreAmberSigner,
  restoreBunkerSigner,
  clearAmberSigner,
  clearBunkerSigner,
  shortNpub,
  type NostrIdentity,
  type ProfileMetadata,
} from './auth';

export { isAmberActive, isBunkerActive, getNip44 } from './signer';
export { isLikelyAndroid, isLikelyIOS } from './amber';
export {
  isBunkerStale,
  subscribeBunkerHealth,
  clearPendingBunkerAttempts,
} from './bunker';

export { fetchProfile } from './profile';

export {
  DEFAULT_RELAYS,
  fetchRelayList,
  resolvePublishRelays,
} from './relays';

export {
  fetchAllPodcastNotes,
  fetchPodcastNotes,
  fetchEpisodeNotes,
  fetchSocialInteractThread,
  noteFromEvent,
  noteHasSubstance,
  type DiscoveredNote,
} from './discover';

export { useNostrFeed } from './use-feed';

export { fetchViewerReposts, useViewerReposts } from './viewer-state';

export {
  publishBoostNote,
  publishBoostNoteViaSite,
} from './boost-notes';

export {
  type PublishedNote,
} from './publish';

export {
  FAVORITES_D_TAG,
  fetchFavoriteGuids,
  publishFavorites,
  schedulePublishFavorites,
  type FavoritesEvent,
} from './favorites';

export {
  WALLET_BACKUP_KIND,
  WALLET_BACKUP_D_TAG,
  WALLET_NWC_D_TAG,
  fetchEncryptedMnemonic,
  publishEncryptedMnemonic,
  fetchEncryptedNwc,
  publishEncryptedNwc,
  deleteEncryptedNwc,
} from './wallet-backup';

export {
  SETTINGS_D_TAG,
  fetchSettings,
  publishSettings,
  recordLastRail,
  type SyncedSettings,
} from './settings-backup';

export {
  INBOX_KIND,
  INBOX_SEEN_D_TAG,
  LISTEN_QUEUE_D_TAG,
  fetchInboxSeen,
  publishInboxSeen,
  scheduleInboxSeenSync,
  fetchListenQueue,
  publishListenQueue,
  scheduleListenQueueSync,
} from './inbox-backup';

export { hydrateFavorites } from './favorites-hydrator';

export {
  MUTES_KIND,
  emptyMuteState,
  fetchMutedPubkeys,
  publishMuteList,
  schedulePublishMuteList,
  unionMutedPubkeys,
  type MuteListState,
} from './mutes';

export { hydrateMutes } from './mutes-hydrator';

export {
  fetchNostrLiveStreams,
  fetchLiveStreamByAddr,
  fetchLatestStreamByPubkey,
  streamNaddr,
  resolveStreamV4V,
  streamToEpisode,
  streamToPodcast,
  streamIdOf,
  parseStreamId,
  isLiveStreamId,
  LIVE_STREAM_RELAYS,
  type NostrLiveStream,
} from './live-streams';

export { subscribeLiveChat, publishLiveChat, streamChatAddr } from './live-chat';
