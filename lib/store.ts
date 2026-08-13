'use client';
import { create } from 'zustand';
import type { Episode, Podcast, FavoriteEpisode, FavoritePodcast, ValueBlock } from './types';
import type { NostrIdentity } from './nostr';
import { storage } from './storage';
import { resolvePublishRelays } from './nostr/relays';
import { schedulePublishMuteList, unionMutedPubkeys, type MuteListState } from './nostr/mutes';

/** Which view the sign-in modal opens on. See `signInIntent` below. */
export type SignInIntent = 'default' | 'google';

/** See `favoritesSync` below. */
export type FavoritesSyncStatus = 'idle' | 'loading' | 'ok' | 'degraded';
/** Which of the two shared lists a status refers to. `items` stays 'idle' for
 *  accounts on the legacy single-list address, where no such list exists. */
export type FavoritesList = 'feeds' | 'items';

interface AppState {
  identity: NostrIdentity | null;
  setIdentity: (i: NostrIdentity | null) => void;

  current: { episode: Episode; podcast: Podcast } | null;
  isPlaying: boolean;
  positionSec: number;
  episodeQueue: Episode[];

  play: (episode: Episode, podcast: Podcast, startSec?: number) => void;
  togglePlay: () => void;
  setPlaying: (b: boolean) => void;
  setPosition: (s: number) => void;

  // Whether the current item is playing its video <podcast:alternateEnclosure>
  // rather than the audio enclosure. User-toggled via <VideoToggle>; reset to
  // false whenever the current item changes (play/next/prev), so a new episode
  // always starts on audio. <Player> reads it to route the shared <video>.
  videoMode: boolean;
  setVideoMode: (b: boolean) => void;

  // A seek request for the CURRENT episode, consumed by <Player> (which owns the
  // audio element). The nonce lets the same target fire twice. Surfaces that
  // aren't the player — e.g. a transcript line or chapter in the detail view —
  // request a seek through this instead of touching the media element.
  seekReq: { t: number; n: number } | null;
  requestSeek: (t: number) => void;
  // Swap the CURRENT item's value block without disturbing playback — the live
  // value switch (lib/v4v/live-value.ts). Every `episode.value` reader follows
  // for free. A no-op unless `guid` is the item playing now, so a resolve that
  // lands after the user moved on can't retarget their payment.
  syncCurrentValue: (guid: string, value: ValueBlock | null) => void;
  setEpisodeQueue: (episodes: Episode[]) => void;
  playNext: () => void;
  playPrev: () => void;

  // Whether the fullscreen "Now Playing" player is expanded. Lifted into the
  // store so surfaces outside <Player> (e.g. a live-stream card) can open it.
  // <Player> still owns the <FullscreenPlayer> render — this is just the flag.
  playerExpanded: boolean;
  setPlayerExpanded: (b: boolean) => void;

  // Whether the Nostr sign-in modal is open. Lifted into the store so surfaces
  // other than the header (e.g. the fullscreen player / live chat) can open it
  // without leaving the page. <NostrAuth> owns the modal render.
  //
  // `signInIntent` lets a caller open the modal straight into the Google
  // onboarding panel instead of the signer tabs, so the header can offer
  // "Continue with Google" as a peer of the other logins rather than something
  // you find only after choosing "Sign in with Nostr" — the people that flow
  // exists for are exactly the ones who don't know what Nostr is. It's an
  // opening intent, not modal state: the panel's own back affordance returns to
  // the default view, and every existing setSignInOpen(true) call is unchanged.
  signInOpen: boolean;
  signInIntent: SignInIntent;
  setSignInOpen: (b: boolean, intent?: SignInIntent) => void;

  // Whether the Lightning wallet modal is open. Lifted into the store — like
  // signInOpen — so any surface can open the one shared <WalletModal> (owned by
  // <WalletControl> in the header) without prop-drilling. Wallet auth is fully
  // independent of Nostr: connecting a wallet never requires an identity.
  walletOpen: boolean;
  setWalletOpen: (b: boolean) => void;

  // True while a wallet we have positive evidence for is coming back up on
  // page load. Without it the header reads `hasAnyWallet()`, which is false
  // during the Spark SDK import + operator handshake, and offers "Connect
  // wallet" for a wallet the user already has. Set only when a restore is
  // genuinely expected (see doLoadProfile) — never speculatively, or it just
  // relabels the button for people who have no wallet at all.
  walletRestoring: boolean;
  setWalletRestoring: (b: boolean) => void;

  // The podcast currently shown in the detail view. Lifted into the store so
  // surfaces outside `app/page.tsx` (e.g. a podcast-name link in a Nostr note
  // card) can navigate to a show without prop-drilling.
  selectedPodcast: Podcast | null;
  selectPodcast: (p: Podcast | null) => void;
  // Refresh selectedPodcast with a fresher/enriched copy of the SAME show —
  // e.g. the RSS-enriched podcast from /api/feed, which carries funding /
  // medium / podroll that PI's by-guid lookup doesn't index — WITHOUT touching
  // the current episode/discussion navigation. No-op for a different show.
  syncSelectedPodcast: (p: Podcast | null) => void;

  // When set, the page swaps to a full-screen discussion view for this
  // episode's podcast:socialInteract thread (opened from the "💬 discussion"
  // button). Takes precedence over the detail/browse views in app/page.tsx.
  discussionEpisode: Episode | null;
  openDiscussion: (e: Episode) => void;
  closeDiscussion: () => void;

  // When set, the page shows a full-screen episode detail view for this
  // episode (opened from the episode list). Sits between the podcast detail
  // view and the discussion view in the navigation stack.
  selectedEpisode: Episode | null;
  openEpisode: (e: Episode) => void;
  closeEpisode: () => void;

  favorites: Record<string, FavoritePodcast>;
  isFavorite: (guid: string | undefined) => boolean;
  addFavorite: (p: FavoritePodcast) => void;
  removeFavorite: (guid: string) => void;
  setFavorites: (next: Record<string, FavoritePodcast>) => void;

  // Episode favorites, keyed by item guid. Separate map from `favorites`
  // because the two carry different shapes and resolve through different PI
  // endpoints; they share one Nostr list (see lib/nostr/favorites.ts).
  favoriteEpisodes: Record<string, FavoriteEpisode>;
  isFavoriteEpisode: (itemGuid: string | undefined) => boolean;
  addFavoriteEpisode: (e: FavoriteEpisode) => void;
  removeFavoriteEpisode: (itemGuid: string) => void;
  setFavoriteEpisodes: (next: Record<string, FavoriteEpisode>) => void;

  // Whether the favorites relay round-trip is working, so the UI can tell
  // "we couldn't ask" apart from "your list is empty". Those two render
  // identically otherwise, and on a device with no cache the second one reads
  // as "your favorites are gone" — which is what made the degraded-read guard
  // look like the bug it was actually preventing.
  //
  //   'idle'     no read attempted this session (signed out, or pre-hydration)
  //   'loading'  a read is in flight
  //   'ok'       a trustworthy read landed, so an empty list is really empty
  //   'degraded' nothing answered — whatever is on screen is this device's copy
  //
  // In-memory only, deliberately: a persisted "the relays were down" is a lie
  // by the next page load. Written by hydrateFavorites and by syncFavorites'
  // callbacks (see favorites-sync.ts), cleared to 'idle' wherever nostr-auth
  // tears an identity down. NOT reset inside setIdentity — that runs
  // mid-hydration with the enriched identity and would clobber a fresh 'ok'.
  // ONE FLAG PER LIST, and one flag across both is worse than none: a
  // successful feeds read would clear the notice a failed items read set, and
  // the user gets a clean, confident empty state for their nine hundred tracks
  // — precisely the state this flag exists to prevent. In legacy single-list
  // mode `items` stays 'idle' forever and every consumer must ignore 'idle',
  // or every non-allowlisted user (i.e. everyone) gets a permanent false alarm.
  favoritesSync: { feeds: FavoritesSyncStatus; items: FavoritesSyncStatus };
  setFavoritesSync: (list: FavoritesList, s: FavoritesSyncStatus) => void;
  /** Both halves back to 'idle', for the identity teardowns in nostr-auth.
   *  One call so a new list can never be added and left stale in one of the
   *  three places that has to clear it. */
  resetFavoritesSync: () => void;

  /**
   * Item favorites found on the FEEDS list that this device did not put there.
   *
   * Render-only, and deliberately a separate slot rather than a flag on the
   * ordinary map. The spec forbids copying a foreign legacy item entry to the
   * items list: publish it, the user unfavorites it, it comes off the items
   * list, it is still on the feeds list where the merge rightly forbids us
   * removing it, and the next hydration puts it back — the favorite returns on
   * every page load, forever, on every device.
   *
   * `localFavoriteItems()` never reads this map, so "must not enter adds_items"
   * stops being a rule someone has to remember at one specific line and becomes
   * a property of where the data lives. Deriving the set per-publish instead
   * would leak every entry the moment a feeds read came back degraded.
   */
  foreignFavoriteEpisodes: Record<string, FavoriteEpisode>;
  setForeignFavoriteEpisodes: (next: Record<string, FavoriteEpisode>) => void;

  // NIP-51 kind:10000 mute list, hydrated on login from the user's relay
  // event. Filter is applied at render time in NoteCard and feed surfaces.
  mutedPubkeys: Set<string>;
  isMuted: (pubkey: string | undefined) => boolean;
  mutePubkey: (pubkey: string) => void;
  unmutePubkey: (pubkey: string) => void;
  setMutedPubkeys: (next: Set<string>) => void;

  // Increments whenever a boost is written to localStorage so feed surfaces
  // can re-derive without polling. Source of truth stays in storage.boosts.
  boostsTick: number;
  bumpBoosts: () => void;
}

export const useApp = create<AppState>((set, get) => ({
  identity: null,
  setIdentity: (i) => set({ identity: i }),

  current: null,
  isPlaying: false,
  positionSec: 0,
  episodeQueue: [],

  play: (episode, podcast, startSec = 0) =>
    set({ current: { episode, podcast }, isPlaying: true, positionSec: startSec, videoMode: false }),
  togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),
  setPlaying: (b) => set({ isPlaying: b }),
  setPosition: (s) => set({ positionSec: s }),

  videoMode: false,
  setVideoMode: (b) => set({ videoMode: b }),

  seekReq: null,
  requestSeek: (t) => set((s) => ({ seekReq: { t, n: (s.seekReq?.n ?? 0) + 1 } })),
  // Replaces `value` and NOTHING else. Touching episode.id or enclosureUrl
  // would re-run <Player>'s source effect (deps [episode.id, videoMode]) and
  // kill playback and the hls.js attachment mid-broadcast.
  syncCurrentValue: (guid, value) =>
    set((s) => {
      if (!s.current || !guid || s.current.episode.guid !== guid) return {};
      if (s.current.episode.value === value) return {};
      return { current: { ...s.current, episode: { ...s.current.episode, value } } };
    }),
  setEpisodeQueue: (episodes) => set({ episodeQueue: episodes }),
  playNext: () => set((s) => {
    if (!s.current) return s;
    const idx = s.episodeQueue.findIndex((e) => e.id === s.current!.episode.id);
    const next = idx >= 0 ? s.episodeQueue[idx + 1] : undefined;
    if (!next) return s;
    return { current: { episode: next, podcast: s.current.podcast }, isPlaying: true, positionSec: 0, videoMode: false };
  }),
  playPrev: () => set((s) => {
    if (!s.current) return s;
    const idx = s.episodeQueue.findIndex((e) => e.id === s.current!.episode.id);
    const prev = idx > 0 ? s.episodeQueue[idx - 1] : undefined;
    if (!prev) return s;
    return { current: { episode: prev, podcast: s.current.podcast }, isPlaying: true, positionSec: 0, videoMode: false };
  }),

  playerExpanded: false,
  setPlayerExpanded: (b) => set({ playerExpanded: b }),

  signInOpen: false,
  signInIntent: 'default',
  // Reset the intent on close so the next opener that doesn't pass one gets the
  // default view rather than inheriting the last caller's.
  setSignInOpen: (b, intent) => set({ signInOpen: b, signInIntent: b ? (intent ?? 'default') : 'default' }),

  walletOpen: false,
  setWalletOpen: (b) => set({ walletOpen: b }),

  walletRestoring: false,
  setWalletRestoring: (b) => set({ walletRestoring: b }),

  selectedPodcast: null,
  // Leaving the detail view (or switching shows) also drops any open
  // discussion and episode detail so stale views can't outlive their podcast.
  selectPodcast: (p) => set({ selectedPodcast: p, discussionEpisode: null, selectedEpisode: null }),
  syncSelectedPodcast: (p) =>
    set((s) => {
      if (!p || !s.selectedPodcast) return {};
      const same =
        (!!p.podcastGuid && p.podcastGuid === s.selectedPodcast.podcastGuid) ||
        p.id === s.selectedPodcast.id;
      return same ? { selectedPodcast: p } : {};
    }),

  discussionEpisode: null,
  openDiscussion: (e) => set({ discussionEpisode: e }),
  closeDiscussion: () => set({ discussionEpisode: null }),

  selectedEpisode: null,
  openEpisode: (e) => set({ selectedEpisode: e, discussionEpisode: null }),
  closeEpisode: () => set({ selectedEpisode: null }),

  // Hydrate from the guest cache on store creation; once a user signs in,
  // nostr-auth.tsx replaces this with the per-npub set.
  favorites: storage.favorites.get(null),
  isFavorite: (guid) => !!guid && !!get().favorites[guid],
  addFavorite: (p) => set((s) => {
    const next = { ...s.favorites, [p.podcastGuid]: p };
    storage.favorites.set(s.identity?.npub, next);
    return { favorites: next };
  }),
  removeFavorite: (guid) => set((s) => {
    if (!s.favorites[guid]) return s;
    const next = { ...s.favorites };
    delete next[guid];
    storage.favorites.set(s.identity?.npub, next);
    return { favorites: next };
  }),
  setFavorites: (next) => set((s) => {
    storage.favorites.set(s.identity?.npub, next);
    return { favorites: next };
  }),

  favoriteEpisodes: storage.favoriteEpisodes.get(null),
  isFavoriteEpisode: (itemGuid) => !!itemGuid && !!get().favoriteEpisodes[itemGuid],
  addFavoriteEpisode: (e) => set((s) => {
    const next = { ...s.favoriteEpisodes, [e.itemGuid]: e };
    storage.favoriteEpisodes.set(s.identity?.npub, next);
    return { favoriteEpisodes: next };
  }),
  removeFavoriteEpisode: (itemGuid) => set((s) => {
    if (!s.favoriteEpisodes[itemGuid]) return s;
    const next = { ...s.favoriteEpisodes };
    delete next[itemGuid];
    storage.favoriteEpisodes.set(s.identity?.npub, next);
    return { favoriteEpisodes: next };
  }),
  setFavoriteEpisodes: (next) => set((s) => {
    storage.favoriteEpisodes.set(s.identity?.npub, next);
    return { favoriteEpisodes: next };
  }),

  favoritesSync: { feeds: 'idle', items: 'idle' },
  setFavoritesSync: (list, s) =>
    set((prev) => ({ favoritesSync: { ...prev.favoritesSync, [list]: s } })),
  resetFavoritesSync: () => set({ favoritesSync: { feeds: 'idle', items: 'idle' } }),

  // Not persisted: it is rebuilt from the feeds list on every hydrate, and a
  // stale copy would be indistinguishable from an entry that is genuinely ours.
  foreignFavoriteEpisodes: {},
  setForeignFavoriteEpisodes: (next) => set({ foreignFavoriteEpisodes: next }),

  // Hydrate from the guest cache; once the user signs in, hydrateMutes
  // replaces this with their NIP-51 set reconciled against the relay event.
  mutedPubkeys: unionMutedPubkeys(storage.muted.get(null)),
  isMuted: (pubkey) => !!pubkey && get().mutedPubkeys.has(pubkey),
  mutePubkey: (pubkey) => set((s) => {
    if (!pubkey || s.mutedPubkeys.has(pubkey)) return s;
    const cur = storage.muted.get(s.identity?.npub);
    // New mutes default to PRIVATE — matches Damus's default. The publish
    // path falls back to public if the signer can't NIP-04-encrypt.
    const nextState: MuteListState = {
      ...cur,
      privatePubkeys: cur.privatePubkeys.includes(pubkey)
        ? cur.privatePubkeys
        : [...cur.privatePubkeys, pubkey],
      updatedAt: Math.floor(Date.now() / 1000),
    };
    persistMuted(s.identity, nextState);
    return { mutedPubkeys: unionMutedPubkeys(nextState) };
  }),
  unmutePubkey: (pubkey) => set((s) => {
    if (!pubkey || !s.mutedPubkeys.has(pubkey)) return s;
    const cur = storage.muted.get(s.identity?.npub);
    // Remove from BOTH lists so unmute is the inverse of either mute path.
    const nextState: MuteListState = {
      ...cur,
      publicPubkeys: cur.publicPubkeys.filter((p) => p !== pubkey),
      privatePubkeys: cur.privatePubkeys.filter((p) => p !== pubkey),
      updatedAt: Math.floor(Date.now() / 1000),
    };
    persistMuted(s.identity, nextState);
    return { mutedPubkeys: unionMutedPubkeys(nextState) };
  }),
  setMutedPubkeys: (next) => set({ mutedPubkeys: next }),

  boostsTick: 0,
  bumpBoosts: () => set((s) => ({ boostsTick: s.boostsTick + 1 })),
}));

// Persist the full mute-list state and (when signed in) schedule a debounced
// kind:10000 republish. The encryption decision happens at publish time so
// the signer's NIP-04 capability is checked in one place.
function persistMuted(identity: NostrIdentity | null, state: MuteListState) {
  const npub = identity?.npub ?? null;
  storage.muted.set(npub, state);
  if (!identity) return; // guest mutes stay local — can't sign without a key
  schedulePublishMuteList(
    identity.pubkey,
    () => storage.muted.get(identity.npub),
    resolvePublishRelays(identity),
  );
}
