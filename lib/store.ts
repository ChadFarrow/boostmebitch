'use client';
import { create } from 'zustand';
import type { Episode, Podcast, FavoritePodcast } from './types';
import type { NostrIdentity } from './nostr';
import { storage } from './storage';
import { isMusicMedium } from './util';
import { resolvePublishRelays } from './nostr/relays';
import { schedulePublishMuteList, unionMutedPubkeys, type MuteListState } from './nostr/mutes';
import { scheduleInboxSeenSync, scheduleListenQueueSync } from './nostr/inbox-backup';

/** Stable per-episode identity for seen-tracking + the listen queue. Prefers the
 *  Nostr/RSS guid; falls back to feedId:id so items without a guid still key. */
export const epKey = (e: Episode) => e.guid ?? `${e.feedId}:${e.id}`;

/** A listen-queue entry carries its OWN podcast — the queue mixes shows, so we
 *  can't reuse `current.podcast` the way the single-show episodeQueue does. */
export interface QueueItem {
  episode: Episode;
  podcast: Podcast;
}

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

  // Inbox "seen"/handled episode keys (epKey). An episode leaves the inbox's
  // "new" list once it's here — set by mark-seen, finishing playback, or being
  // added to the listen queue. Persisted per-npub.
  seenGuids: Set<string>;
  isSeen: (key: string | undefined) => boolean;
  markSeen: (episode: Episode) => void;
  // Mark many episode keys seen at once — used to seed a newly-favorited show's
  // back-catalog as seen so only its newest episode shows as NEW.
  seedSeenKeys: (keys: string[]) => void;
  setSeenGuids: (next: Set<string>) => void;

  // The listen queue ("Up Next"): an ordered, cross-show list the user lines up
  // and auto-listens through. Separate from episodeQueue (that's the open show's
  // tracklist). Each item carries its own podcast. Persisted per-npub.
  listenQueue: QueueItem[];
  enqueueEpisode: (episode: Episode, podcast: Podcast) => void;
  removeFromQueue: (key: string) => void;
  moveQueueItem: (index: number, dir: -1 | 1) => void;
  clearQueue: () => void;
  playFromQueue: (index: number) => void;
  setListenQueue: (next: QueueItem[]) => void;

  // Called by <Player> on media 'ended'. Marks the finished episode seen; if it
  // was in the listen queue, drains it and auto-plays the next queue item;
  // otherwise falls back to today's music album-advance / stop behavior.
  handlePlaybackEnded: () => void;

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
    // Listen queue takes precedence when the current episode came from it —
    // advance to the next queued item (with ITS own podcast). "Up Next wins",
    // consistent with handlePlaybackEnded.
    const qIdx = s.listenQueue.findIndex((i) => epKey(i.episode) === epKey(s.current!.episode));
    if (qIdx >= 0) {
      // Skipping clears the one you're leaving (same as finishing it). Only the
      // CURRENT item is removed — items you merely tapped past stay, so the
      // queue remains jumpable.
      const nextItem = s.listenQueue[qIdx + 1];
      const nextQueue = s.listenQueue.filter((_, i) => i !== qIdx);
      persistQueue(s.identity, nextQueue);
      // Last item → clear it and stop (the queue is now empty).
      if (!nextItem) return { listenQueue: nextQueue, isPlaying: false };
      return { listenQueue: nextQueue, current: { episode: nextItem.episode, podcast: nextItem.podcast }, isPlaying: true, positionSec: 0 };
    }
    // Fallback: the open show's episodeQueue (single-show — reuse current podcast).
    const idx = s.episodeQueue.findIndex((e) => e.id === s.current!.episode.id);
    const next = idx >= 0 ? s.episodeQueue[idx + 1] : undefined;
    if (!next) return s;
    return { current: { episode: next, podcast: s.current.podcast }, isPlaying: true, positionSec: 0 };
  }),
  playPrev: () => set((s) => {
    if (!s.current) return s;
    const qIdx = s.listenQueue.findIndex((i) => epKey(i.episode) === epKey(s.current!.episode));
    if (qIdx >= 0) {
      const prevItem = qIdx > 0 ? s.listenQueue[qIdx - 1] : undefined;
      if (!prevItem) return s;
      return { current: { episode: prevItem.episode, podcast: prevItem.podcast }, isPlaying: true, positionSec: 0 };
    }
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

  // Hydrate seen + listen queue from the guest bucket on creation; nostr-auth
  // swaps to the per-npub bucket on login and resets on logout.
  seenGuids: storage.inboxSeen.get(null),
  isSeen: (key) => !!key && get().seenGuids.has(key),
  markSeen: (episode) => set((s) => markSeenInternal(s, episode)),
  seedSeenKeys: (keys) => set((s) => {
    if (!keys.length) return {};
    const next = new Set(s.seenGuids);
    let changed = false;
    for (const k of keys) if (k && !next.has(k)) { next.add(k); changed = true; }
    if (!changed) return {};
    persistSeen(s.identity, next);
    return { seenGuids: next };
  }),
  setSeenGuids: (next) => set({ seenGuids: next }),

  listenQueue: storage.listenQueue.get(null),
  enqueueEpisode: (episode, podcast) => set((s) => {
    const key = epKey(episode);
    const already = s.listenQueue.some((i) => epKey(i.episode) === key);
    // Adding to the queue also marks the episode seen ("adding = handled" →
    // it leaves the inbox). Fold both writes into this one set().
    const seenPatch = markSeenInternal(s, episode);
    if (already) return seenPatch;
    const nextQueue = [...s.listenQueue, { episode, podcast }];
    persistQueue(s.identity, nextQueue);
    return { ...seenPatch, listenQueue: nextQueue };
  }),
  removeFromQueue: (key) => set((s) => {
    const nextQueue = s.listenQueue.filter((i) => epKey(i.episode) !== key);
    if (nextQueue.length === s.listenQueue.length) return s;
    persistQueue(s.identity, nextQueue);
    return { listenQueue: nextQueue };
  }),
  moveQueueItem: (index, dir) => set((s) => {
    const j = index + dir;
    if (index < 0 || j < 0 || index >= s.listenQueue.length || j >= s.listenQueue.length) return s;
    const next = [...s.listenQueue];
    [next[index], next[j]] = [next[j], next[index]];
    persistQueue(s.identity, next);
    return { listenQueue: next };
  }),
  clearQueue: () => set((s) => {
    persistQueue(s.identity, []);
    return { listenQueue: [] };
  }),
  playFromQueue: (index) => set((s) => {
    const item = s.listenQueue[index];
    if (!item) return s;
    // Tapping a row just plays it — the queue is left intact so you can jump
    // around without losing items. Only ⏭ skip and finishing drain.
    return { current: { episode: item.episode, podcast: item.podcast }, isPlaying: true, positionSec: 0 };
  }),
  setListenQueue: (next) => set({ listenQueue: next }),

  handlePlaybackEnded: () => set((s) => {
    const cur = s.current;
    if (!cur) return s;

    // (b) finishing ALWAYS marks the finished episode seen.
    const seenPatch = markSeenInternal(s, cur.episode);

    const key = epKey(cur.episode);
    const qIdx = s.listenQueue.findIndex((i) => epKey(i.episode) === key);

    if (qIdx >= 0) {
      // The finished episode was in the listen queue: drop it and auto-play the
      // item that followed it — with ITS OWN podcast — else stop. The drain.
      const nextItem = s.listenQueue[qIdx + 1];
      const nextQueue = s.listenQueue.filter((_, i) => i !== qIdx);
      persistQueue(s.identity, nextQueue);
      if (nextItem) {
        return {
          ...seenPatch,
          listenQueue: nextQueue,
          current: { episode: nextItem.episode, podcast: nextItem.podcast },
          isPlaying: true,
          positionSec: 0,
        };
      }
      return { ...seenPatch, listenQueue: nextQueue, isPlaying: false };
    }

    // Not a queue episode → preserve existing behavior exactly: music medium
    // advances the open show's album; everything else stops.
    if (isMusicMedium(cur.podcast)) {
      const idx = s.episodeQueue.findIndex((e) => e.id === cur.episode.id);
      const next = idx >= 0 ? s.episodeQueue[idx + 1] : undefined;
      if (next) {
        return { ...seenPatch, current: { episode: next, podcast: cur.podcast }, isPlaying: true, positionSec: 0 };
      }
    }
    return { ...seenPatch, isPlaying: false };
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

// Mark an episode seen, returning a store patch (idempotent — empty patch when
// already seen, so StrictMode double-invokes and repeat calls are no-ops). A
// NEW Set is created so v5 per-field selectors on `seenGuids` re-render.
// Callers fold this into their own set() so seen + queue writes are one update.
function markSeenInternal(s: AppState, episode: Episode): Partial<AppState> {
  const key = epKey(episode);
  if (s.seenGuids.has(key)) return {};
  const next = new Set(s.seenGuids);
  next.add(key);
  persistSeen(s.identity, next);
  return { seenGuids: next };
}

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

// Persist the seen set locally AND (when signed in with a NIP-44 signer)
// schedule a debounced encrypted publish. One choke point so no seen mutation
// site is missed — mirrors persistMuted for the mute list.
function persistSeen(identity: NostrIdentity | null, seen: Set<string>) {
  storage.inboxSeen.set(identity?.npub ?? null, seen);
  if (identity) scheduleInboxSeenSync(identity, seen);
}

// Persist the queue + its edit timestamp locally, and schedule a debounced
// encrypted publish. The timestamp drives newest-wins reconciliation on login.
function persistQueue(identity: NostrIdentity | null, items: QueueItem[]) {
  const ts = Date.now();
  storage.listenQueue.set(identity?.npub ?? null, items);
  storage.listenQueueTs.set(identity?.npub ?? null, ts);
  if (identity) scheduleListenQueueSync(identity, items, ts);
}
