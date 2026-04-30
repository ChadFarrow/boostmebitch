'use client';
import { create } from 'zustand';
import type { Episode, Podcast, FavoritePodcast } from './types';
import type { NostrIdentity } from './nostr';
import { storage } from './storage';

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

  boostsTick: 0,
  bumpBoosts: () => set((s) => ({ boostsTick: s.boostsTick + 1 })),
}));
