'use client';
import { create } from 'zustand';
import type { Episode, Podcast } from './types';
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
}

export const useApp = create<AppState>((set) => ({
  identity: null,
  setIdentity: (i) => set({ identity: i }),

  current: null,
  isPlaying: false,
  positionSec: 0,

  play: (episode, podcast) => set({ current: { episode, podcast }, isPlaying: true, positionSec: 0 }),
  togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),
  setPlaying: (b) => set({ isPlaying: b }),
  setPosition: (s) => set({ positionSec: s }),
}));
