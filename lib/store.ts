'use client';
import { create } from 'zustand';
import type { Episode, Podcast, FavoritePodcast } from './types';
import type { NostrIdentity } from './nostr';
import { storage } from './storage';
import { resolvePublishRelays } from './nostr/relays';
import { schedulePublishMuteList } from './nostr/mutes';

interface AppState {
  identity: NostrIdentity | null;
  setIdentity: (i: NostrIdentity | null) => void;

  current: { episode: Episode; podcast: Podcast } | null;
  isPlaying: boolean;
  positionSec: number;

  play: (episode: Episode, podcast: Podcast) => void;
  togglePlay: () => void;
  setPlaying: (b: boolean) => void;
  setPosition: (s: number) => void;

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

  play: (episode, podcast) => set({ current: { episode, podcast }, isPlaying: true, positionSec: 0 }),
  togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),
  setPlaying: (b) => set({ isPlaying: b }),
  setPosition: (s) => set({ positionSec: s }),

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
  mutedPubkeys: new Set(storage.muted.get(null).pubkeys),
  isMuted: (pubkey) => !!pubkey && get().mutedPubkeys.has(pubkey),
  mutePubkey: (pubkey) => set((s) => {
    if (!pubkey || s.mutedPubkeys.has(pubkey)) return s;
    const next = new Set(s.mutedPubkeys);
    next.add(pubkey);
    persistMuted(s.identity, next);
    return { mutedPubkeys: next };
  }),
  unmutePubkey: (pubkey) => set((s) => {
    if (!pubkey || !s.mutedPubkeys.has(pubkey)) return s;
    const next = new Set(s.mutedPubkeys);
    next.delete(pubkey);
    persistMuted(s.identity, next);
    return { mutedPubkeys: next };
  }),
  setMutedPubkeys: (next) => set({ mutedPubkeys: next }),

  boostsTick: 0,
  bumpBoosts: () => set((s) => ({ boostsTick: s.boostsTick + 1 })),
}));

// Write the new pubkey set to localStorage and (when signed in) schedule a
// debounced kind:10000 republish. otherTags from the existing cache ride
// along untouched so cross-client hashtag/keyword mutes survive.
function persistMuted(identity: NostrIdentity | null, next: Set<string>) {
  const npub = identity?.npub ?? null;
  const prev = storage.muted.get(npub);
  const pubkeys = Array.from(next);
  storage.muted.set(npub, {
    pubkeys,
    otherTags: prev.otherTags,
    updatedAt: Math.floor(Date.now() / 1000),
  });
  if (!identity) return; // guest mutes stay local — can't sign without a key
  schedulePublishMuteList(
    () => Array.from(useApp.getState().mutedPubkeys),
    () => storage.muted.get(identity.npub).otherTags,
    resolvePublishRelays(identity),
  );
}
