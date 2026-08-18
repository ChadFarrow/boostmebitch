// Barrel re-export so callers can keep using `@/lib/nostr` after the split.
// New code can import from the specific submodule (`@/lib/nostr/favorites`)
// for clearer dependency graphs.

export {
  loginWithExtension,
  loginWithAmber,
  loginWithBunker,
  loginWithNostrConnect,
  loginWithLocalKey,
  restoreAmberSigner,
  restoreBunkerSigner,
  restoreLocalSigner,
  clearAmberSigner,
  clearBunkerSigner,
  clearLocalSigner,
  shortNpub,
  coerceProfileMetadata,
  type NostrIdentity,
  type ProfileMetadata,
} from './auth';

export { isAmberActive, isBunkerActive, isLocalActive, getNip44 } from './signer';
// Exported for abandonRestoredSession: dropping the polyfill without wiping
// the stored key (which is what clearLocalSigner does).
export { deactivateLocalSigner } from './signer';
export { isKeyEphemeral } from './local-key-store';
export { isGoogleAuthConfigured } from './google-auth';
export { isLikelyAndroid, isLikelyIOS } from './amber';
export {
  isBunkerStale,
  subscribeBunkerHealth,
  clearPendingBunkerAttempts,
} from './bunker';

export { fetchProfile, fetchRawProfile, publishProfile, type RawProfile } from './profile';

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
  fetchBoostsSentBy,
  fetchBoostsReceivedBy,
  fetchZapsReceivedBy,
  quotedEventIds,
  noteFromEvent,
  noteHasSubstance,
  type DiscoveredNote,
  type ReceivedZap,
} from './discover';

export { parseZapReceipt, zapSats, type ZapReceipt } from './zap-receipt';

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
  FAVORITES_KIND,
  LIST_ALT,
  showId,
  itemId,
  looksLikeFeedGuid,
  parseShowGuid,
  parseItemGuid,
  identifierKind,
  parseFavoritesList,
  groupLocalFavorites,
  mergeFavoritesList,
  tagsFromList,
  baselineFrom,
  planFavoritesPublish,
  partitionList,
  fetchFavoritesList,
  publishFavoritesTags,
  syncFavorites,
  type FavoriteEntry,
  type FavoritesBaseline,
  type FavoritesRead,
  type LocalList,
  type ParsedList,
  type SyncOptions,
} from './favorites';

// `scheduleSyncFavorites` deliberately isn't here any more: every favorites
// cycle has to be both debounced and queued, and a scheduler that skipped the
// queue was a second way in. Use `requestFavoritesSync`.
export {
  localFavoriteEntries,
  localFavoriteList,
  requestFavoritesSync,
  serializeFavoritesCycle,
  syncFavoritesNow,
  syncOptionsFor,
} from './favorites-sync';

export {
  WALLET_BACKUP_KIND,
  WALLET_BACKUP_D_TAG,
  WALLET_NWC_D_TAG,
  fetchEncryptedMnemonic,
  fetchEncryptedMnemonicDetailed,
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
