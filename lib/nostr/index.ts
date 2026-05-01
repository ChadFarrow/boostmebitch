// Barrel re-export so callers can keep using `@/lib/nostr` after the split.
// New code can import from the specific submodule (`@/lib/nostr/favorites`)
// for clearer dependency graphs.

export {
  loginWithExtension,
  shortNpub,
  type NostrIdentity,
  type ProfileMetadata,
} from './auth';

export { fetchProfile } from './profile';

export {
  DEFAULT_RELAYS,
  fetchRelayList,
  resolvePublishRelays,
} from './relays';

export {
  fetchAllPodcastNotes,
  fetchPodcastNotes,
  type DiscoveredNote,
} from './discover';

export { useNostrFeed } from './use-feed';

export { fetchViewerReposts, useViewerReposts } from './viewer-state';

export {
  publishBoostNote,
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
  fetchEncryptedMnemonic,
  publishEncryptedMnemonic,
} from './wallet-backup';

export { hydrateFavorites } from './favorites-hydrator';

export {
  MUTES_KIND,
  fetchMutedPubkeys,
  publishMuteList,
  schedulePublishMuteList,
  type MuteListEvent,
} from './mutes';

export { hydrateMutes } from './mutes-hydrator';
