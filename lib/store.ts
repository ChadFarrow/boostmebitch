'use client';
import { create } from 'zustand';
import type { Episode, Podcast, FavoritePodcast } from './types';
import type { NostrIdentity } from './nostr';

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
}

const FAV_KEY_GUEST = 'bmb:favorites:guest';
function favKey(npub: string | null | undefined) {
  return npub ? `bmb:favorites:${npub}` : FAV_KEY_GUEST;
}

function loadInitialFavorites(): Record<string, FavoritePodcast> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(FAV_KEY_GUEST);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persistFavorites(npub: string | null | undefined, favs: Record<string, FavoritePodcast>) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(favKey(npub), JSON.stringify(favs));
  } catch { /* quota etc — ignore */ }
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

  favorites: loadInitialFavorites(),
  isFavorite: (guid) => !!guid && !!get().favorites[guid],
  addFavorite: (p) => set((s) => {
    const next = { ...s.favorites, [p.podcastGuid]: p };
    persistFavorites(s.identity?.npub, next);
    return { favorites: next };
  }),
  removeFavorite: (guid) => set((s) => {
    if (!s.favorites[guid]) return s;
    const next = { ...s.favorites };
    delete next[guid];
    persistFavorites(s.identity?.npub, next);
    return { favorites: next };
  }),
  setFavorites: (next) => set((s) => {
    persistFavorites(s.identity?.npub, next);
    return { favorites: next };
  }),
}));
