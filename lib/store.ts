'use client';
import { create } from 'zustand';
import type { Episode, Podcast, FavoritePodcast } from './types';
import type { NostrIdentity } from './nostr';
import { storage } from './storage';
import { resolvePublishRelays } from './nostr/relays';
import { schedulePublishMuteList, unionMutedPubkeys, type MuteListState } from './nostr/mutes';

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

  // A seek request for the CURRENT episode, consumed by <Player> (which owns the
  // audio element). The nonce lets the same target fire twice. Surfaces that
  // aren't the player — e.g. a transcript line or chapter in the detail view —
  // request a seek through this instead of touching the media element.
  seekReq: { t: number; n: number } | null;
  requestSeek: (t: number) => void;
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
  signInOpen: boolean;
  setSignInOpen: (b: boolean) => void;

  // Whether the Lightning wallet modal is open. Lifted into the store — like
  // signInOpen — so any surface can open the one shared <WalletModal> (owned by
  // <WalletControl> in the header) without prop-drilling. Wallet auth is fully
  // independent of Nostr: connecting a wallet never requires an identity.
  walletOpen: boolean;
  setWalletOpen: (b: boolean) => void;

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
    set({ current: { episode, podcast }, isPlaying: true, positionSec: startSec }),
  togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),
  setPlaying: (b) => set({ isPlaying: b }),
  setPosition: (s) => set({ positionSec: s }),

  seekReq: null,
  requestSeek: (t) => set((s) => ({ seekReq: { t, n: (s.seekReq?.n ?? 0) + 1 } })),
  setEpisodeQueue: (episodes) => set({ episodeQueue: episodes }),
  playNext: () => set((s) => {
    if (!s.current) return s;
    const idx = s.episodeQueue.findIndex((e) => e.id === s.current!.episode.id);
    const next = idx >= 0 ? s.episodeQueue[idx + 1] : undefined;
    if (!next) return s;
    return { current: { episode: next, podcast: s.current.podcast }, isPlaying: true, positionSec: 0 };
  }),
  playPrev: () => set((s) => {
    if (!s.current) return s;
    const idx = s.episodeQueue.findIndex((e) => e.id === s.current!.episode.id);
    const prev = idx > 0 ? s.episodeQueue[idx - 1] : undefined;
    if (!prev) return s;
    return { current: { episode: prev, podcast: s.current.podcast }, isPlaying: true, positionSec: 0 };
  }),

  playerExpanded: false,
  setPlayerExpanded: (b) => set({ playerExpanded: b }),

  signInOpen: false,
  setSignInOpen: (b) => set({ signInOpen: b }),

  walletOpen: false,
  setWalletOpen: (b) => set({ walletOpen: b }),

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
