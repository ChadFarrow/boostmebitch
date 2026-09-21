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
  startBunkerRevive,
  restoreLocalSigner,
  clearAmberSigner,
  clearBunkerSigner,
  clearLocalSigner,
  shortNpub,
  coerceProfileMetadata,
  type BunkerRestoreResult,
  type NostrIdentity,
  type ProfileMetadata,
} from './auth';

export { isAmberActive, canSignUnattended, getNip44 } from './signer';
// Exported for abandonRestoredSession: dropping the polyfill without wiping
// the stored key (which is what clearLocalSigner does).
export { deactivateLocalSigner } from './signer';
export { isKeyEphemeral } from './local-key-store';
export { isGoogleAuthConfigured } from './google-auth';
export { isLikelyAndroid, isLikelyIOS, normalizeAmberPubkey } from './amber';
export {
  bunkerRefusal,
  bunkerRequestTooLarge,
  subscribeBunkerHealth,
  subscribeBunkerApproval,
  cancelBunkerApprovalWait,
  subscribeBunkerRestore,
  clearPendingBunkerAttempts,
  looksLikeBunkerInput,
  nostrConnectUri,
  hasPendingNostrConnect,
  type BunkerApprovalStage,
  type BunkerRestoreStage,
} from './bunker';
export {
  claveOpenLink,
  claveUniversalLink,
  CLAVE_APP_STORE_URL,
} from './clave';
export { primalConnectUrl, PRIMAL_PLAY_URL } from './primal';

export { fetchProfile, fetchRawProfile, publishProfile } from './profile';

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
  fetchProfilesFor,
  quotedEventIds,
  noteFromEvent,
  noteHasSubstance,
  type DiscoveredNote,
  type ReceivedZap,
} from './discover';

export { parseZapReceipt, zapSats, type ZapReceipt } from './zap-receipt';
export type { Nip73Refs } from './zap-request';
export { mintSummaryReceipt } from './zap-summary-receipt';
export type { QuotedZapReceipt } from './zap-receipt-wait';

export { useNostrFeed, useVisibleNotes } from './use-feed';

// The read index (services/nostr-index). Every one of these returns null when
// there is no index, it is unreachable, or it holds nothing — never an empty
// array, which would read as "there are none".
export {
  indexedGlobalNotes,
  indexedPodcastNotes,
  indexedEpisodeNotes,
  indexedBoostsSentBy,
  indexedBoostsReceivedBy,
  indexedZapsReceivedBy,
  indexedLiveStreams,
} from './index-client';

export { useViewerReposts } from './viewer-state';

export {
  publishBoostNote,
  publishBoostNoteViaSite,
  noteNpubs,
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
  baselineHalf,
  baselineForHalves,
  encodePrivateFavorites,
  decodePrivateFavorites,
  planFavoritesPublish,
  partitionList,
  fetchFavoritesList,
  publishFavoritesTags,
  syncFavorites,
  withdrawFavorites,
  PRIVATE_FAVORITES_ENABLED,
  PRIVATE_PLAINTEXT_MAX,
  type FavoriteEntry,
  type FavoritesBaseline,
  type FavoritesPrivacy,
  type FavoritesRead,
  type ListHalf,
  type LocalList,
  type ParsedList,
  type PublishReason,
  type SyncOptions,
} from './favorites';

// `scheduleSyncFavorites` deliberately isn't here any more: every favorites
// cycle has to be both debounced and queued, and a scheduler that skipped the
// queue was a second way in. Use `requestFavoritesSync`.
export {
  favoritesMode,
  seedFavoritesMode,
  privateFavoritesEnabled,
  unattendedDecryptOk,
  onFavoritesModeNeeded,
  localFavoriteEntries,
  localFavoriteList,
  requestFavoritesSync,
  serializeFavoritesCycle,
  syncFavoritesNow,
  withdrawThisDevice,
} from './favorites-sync';

export {
  fetchEncryptedMnemonic,
  fetchEncryptedMnemonicDetailed,
  publishEncryptedMnemonic,
  fetchEncryptedNwc,
  fetchEncryptedNwcDetailed,
  publishEncryptedNwc,
  deleteEncryptedNwc,
} from './wallet-backup';

export {
  fetchSettings,
  applySyncedSettings,
  recordLastRail,
  recordFavoritesPrivacy,
} from './settings-backup';

export { hydrateFavorites } from './favorites-hydrator';

export {
  MUTES_KIND,
  emptyMuteState,
  fetchMutedPubkeys,
  publishMuteList,
  schedulePublishMuteList,
  unionMutedPubkeys,
  classifyMuteContent,
  parseMuteTags,
  type MuteListState,
  type MuteCipher,
} from './mutes';

export { hydrateMutes } from './mutes-hydrator';

export {
  fetchNostrLiveStreams,
  fetchLiveStreamByAddr,
  fetchLatestStreamByPubkey,
  streamNaddr,
  resolveStreamV4V,
  resolveStreamV4VRetrying,
  streamToEpisode,
  streamToPodcast,
  streamIdOf,
  parseStreamId,
  isLiveStreamId,
  LIVE_STREAM_RELAYS,
  type NostrLiveStream,
  type StreamV4V,
} from './live-streams';

export { subscribeLiveChat, publishLiveChat, streamChatAddr } from './live-chat';
