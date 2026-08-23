'use client';
import { create } from 'zustand';
import type { Episode, Podcast, FavoriteEpisode, FavoritePodcast, ValueBlock } from './types';
import type { NostrIdentity, PublishReason } from './nostr';
import { storage } from './storage';
import { resolvePublishRelays } from './nostr/relays';
import { schedulePublishMuteList, unionMutedPubkeys, type MuteListState } from './nostr/mutes';

/** Which view the sign-in modal opens on. See `signInIntent` below. */
export type SignInIntent = 'default' | 'google';

/** See `favoritesSync` below. */
export type FavoritesSyncStatus = 'idle' | 'loading' | 'ok' | 'degraded' | 'off';

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

  // Whether the buffer can currently afford heavy third-party artwork —
  // <Player>'s `artOk` gate, after the "nothing is playing, so there is no
  // enclosure to outrank" allowance. Chapter and live-block art is arbitrary
  // media, routinely on the same origin as the audio and routinely enormous,
  // and one ungated surface starves the element just as thoroughly as two.
  //
  // Lifted into the store because the gate now has a consumer <Player> cannot
  // reach by prop: <LivePlayedTracks> renders on the episode page as well as
  // inside <FullscreenPlayer>. True by default so a surface that mounts before
  // playback starts is not blank. <Player> is the only writer.
  artOk: boolean;
  setArtOk: (b: boolean) => void;

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
  /**
   * True when a page load DELIBERATELY did not read this account's
   * encrypted-to-self backups (Spark seed, NWC URI, synced settings).
   *
   * Set on Amber only. Amber's approval sheet renders decrypted plaintext, so
   * an unattended decrypt on page load puts a **seed phrase** on screen before
   * the user has touched anything — see `doLoadProfile`. Refusing is right; a
   * user whose wallet then does not come back on a new device, with nothing
   * explaining why, is not. CLAUDE.md: a guard that silently withholds must say
   * so, and this flag is how.
   */
  walletBackupWithheld: boolean;
  setWalletRestoring: (b: boolean) => void;
  setWalletBackupWithheld: (b: boolean) => void;

  // The podcast currently shown in the detail view. Lifted into the store so
  // surfaces outside `app/page.tsx` (e.g. a podcast-name link in a Nostr note
  // card) can navigate to a show without prop-drilling.
  selectedPodcast: Podcast | null;
  selectPodcast: (p: Podcast | null) => void;
  /**
   * Where the show on screen was opened FROM, when that was another route.
   *
   * The detail view lives on `/` and its back control used to be unconditional
   * — "← back to results", clearing the selection in place. That was true while
   * every way into a show was on `/`. It is not true now: `/favorites` and
   * `/npub/<npub>` both open a show by setting this store and navigating here,
   * so the back control offered a return to a results list the user had never
   * seen and no way at all back to the page they actually came from.
   *
   * `label` rides along rather than being derived from `path`, because
   * `/npub/<npub>` cannot be turned into "boosts" by inspection and a route
   * that names itself is one fewer thing to keep in sync.
   *
   * In-memory like the rest of the navigation state, so a reload of
   * `/?podcast=…` correctly forgets it — that visitor arrived by URL and has no
   * origin to go back to.
   */
  showOrigin: { path: string; label: string } | null;
  setShowOrigin: (o: { path: string; label: string } | null) => void;
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
  // ONE flag, where there used to be one per list.
  //
  // That is a consequence of the format change, not a relaxation of the old
  // rule. Two flags existed because there were two events that could fail
  // independently, and a single flag across them let a good read on one clear
  // the notice the other's failure had raised — handing the user a confident
  // empty state for their whole track library. There is one event now, so a
  // partial failure is not expressible and one flag cannot lie.
  //
  // 'idle' still is not a failure: it is the pre-hydration and signed-out
  // state, and a consumer that treats it as one shows every visitor a relay
  // warning before anything has been attempted.
  //
  // 'off' is NOT 'idle', and the difference is a whole render state. Both mean
  // "no read has happened", but 'idle' means *not yet* and 'off' means *not
  // ever* — the user chose "not on Nostr". A surface that folds them together
  // sits on "loading your favorites…" forever, because the thing it is waiting
  // for is never going to start. Anything that treats 'idle' as in-flight has
  // to exclude 'off' explicitly.
  favoritesSync: FavoritesSyncStatus;
  /**
   * WHY the last cycle withheld, when it did.
   *
   * `favoritesSync` alone says "we didn't write", which was enough while every
   * withholding had the same cause and the same sentence. It no longer is: a
   * private half this signer cannot decrypt and a relay set that never answered
   * both render as a shorter list, and the user cannot tell "hidden here by
   * choice" from "this app has not been able to open it" without being told
   * which. Null while the status is anything but 'degraded'.
   */
  favoritesSyncReason: PublishReason | null;
  setFavoritesSync: (s: FavoritesSyncStatus, reason?: PublishReason) => void;
  /** Back to 'idle', for the identity teardowns in nostr-auth. Kept as its own
   *  call so the three places that clear it can't drift. */
  resetFavoritesSync: () => void;

  /**
   * The "where should these go?" dialog is open.
   *
   * Lifted for the same reason `signInOpen` and `walletOpen` are: the thing
   * that decides it has to open is `requestFavoritesSync`, the one funnel every
   * heart goes through, and the thing that renders it is a modal mounted once
   * in <AppHeader>. Thirteen heart render sites cannot each own a dialog.
   */
  favPrivacyPrompt: boolean;
  setFavPrivacyPrompt: (open: boolean) => void;

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


// A FAVORITES WRITE THAT DID NOT REACH DISK MUST NOT LEAVE ITS BASELINE BEHIND.
//
// `storage.favBaseline` is a promise that this device's local state will keep
// asserting those ids, and it is what tells another app's entry from one the
// user removed here. It is a few hundred bytes. The favourites it speaks for
// are hundreds of KB of titles, authors and artwork URLs, written to a
// different key with no atomicity between them.
//
// So the small one lands and the large one does not. `safeSet` falls back to an
// in-memory mirror it cannot persist, and the next page load reads a baseline
// naming every favourite beside a cache holding none — which reads as "this
// device removed all of them". That is how a live account lost 213 groups and
// 232 items on 2026-08-21.
//
// `trustedBaseline` (lib/nostr/favorites-sync.ts) already refuses a baseline on
// a device caching NOTHING. This covers the case it cannot see: a STALE cache,
// where an older, smaller write persisted and the newer one did not. Non-empty,
// so it looks believable, and the difference between the two is a silent
// partial delete.
//
// Clearing costs one delayed unfavourite; the next successful cycle rewrites
// both keys together. Both callers pass the npub they just wrote under, so a
// signed-out (guest) write has no baseline to drop.
function dropBaselineIfWriteFailed(landed: boolean, npub: string | undefined, what: string) {
  if (landed || !npub) return;
  storage.favBaseline.set(npub, { feeds: [], items: [] });
  // eslint-disable-next-line no-console
  console.warn(
    `[favorites] the ${what} cache did not reach disk — dropping this device's baseline so it `
    + 'cannot be read as a removal on the next load. Local state is intact for this session only.',
  );
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

  artOk: true,
  setArtOk: (b) => set({ artOk: b }),

  signInOpen: false,
  signInIntent: 'default',
  // Reset the intent on close so the next opener that doesn't pass one gets the
  // default view rather than inheriting the last caller's.
  setSignInOpen: (b, intent) => set({ signInOpen: b, signInIntent: b ? (intent ?? 'default') : 'default' }),

  walletOpen: false,
  setWalletOpen: (b) => set({ walletOpen: b }),

  walletRestoring: false,
  setWalletRestoring: (b) => set({ walletRestoring: b }),
  walletBackupWithheld: false,
  setWalletBackupWithheld: (b) => set({ walletBackupWithheld: b }),

  selectedPodcast: null,
  // Leaving the detail view (or switching shows) also drops any open
  // discussion and episode detail so stale views can't outlive their podcast.
  // Clearing `showOrigin` here rather than at each call site is what makes the
  // default safe: an ordinary selection — a search result, a podroll card, a
  // deep link — resets the origin without knowing the field exists, and only
  // the two handoffs that genuinely came from elsewhere set it back, right
  // after this call. The inverse (set everywhere, clear at the exits) is the
  // shape that leaves one exit forgotten and sends the user to a page they were
  // never on.
  selectPodcast: (p) =>
    set({ selectedPodcast: p, discussionEpisode: null, selectedEpisode: null, showOrigin: null }),

  showOrigin: null,
  setShowOrigin: (o) => set({ showOrigin: o }),
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
    dropBaselineIfWriteFailed(storage.favorites.set(s.identity?.npub, next), s.identity?.npub, 'favorites');
    return { favorites: next };
  }),
  removeFavorite: (guid) => set((s) => {
    if (!s.favorites[guid]) return s;
    const next = { ...s.favorites };
    delete next[guid];
    dropBaselineIfWriteFailed(storage.favorites.set(s.identity?.npub, next), s.identity?.npub, 'favorites');
    return { favorites: next };
  }),
  setFavorites: (next) => set((s) => {
    dropBaselineIfWriteFailed(storage.favorites.set(s.identity?.npub, next), s.identity?.npub, 'favorites');
    return { favorites: next };
  }),

  favoriteEpisodes: storage.favoriteEpisodes.get(null),
  isFavoriteEpisode: (itemGuid) => !!itemGuid && !!get().favoriteEpisodes[itemGuid],
  addFavoriteEpisode: (e) => set((s) => {
    const next = { ...s.favoriteEpisodes, [e.itemGuid]: e };
    dropBaselineIfWriteFailed(storage.favoriteEpisodes.set(s.identity?.npub, next), s.identity?.npub, 'favorite-episodes');
    return { favoriteEpisodes: next };
  }),
  removeFavoriteEpisode: (itemGuid) => set((s) => {
    if (!s.favoriteEpisodes[itemGuid]) return s;
    const next = { ...s.favoriteEpisodes };
    delete next[itemGuid];
    dropBaselineIfWriteFailed(storage.favoriteEpisodes.set(s.identity?.npub, next), s.identity?.npub, 'favorite-episodes');
    return { favoriteEpisodes: next };
  }),
  setFavoriteEpisodes: (next) => set((s) => {
    dropBaselineIfWriteFailed(storage.favoriteEpisodes.set(s.identity?.npub, next), s.identity?.npub, 'favorite-episodes');
    return { favoriteEpisodes: next };
  }),

  favoritesSync: 'idle',
  favoritesSyncReason: null,
  // The reason is cleared on every non-degraded status rather than left behind:
  // a stale "your signer couldn't decrypt this" sitting under a healthy 'ok' is
  // a notice about a problem that is over, which is the same lie as a silent
  // withholding pointed the other way.
  setFavoritesSync: (s, reason) =>
    set({ favoritesSync: s, favoritesSyncReason: s === 'degraded' ? (reason ?? null) : null }),
  resetFavoritesSync: () => set({ favoritesSync: 'idle', favoritesSyncReason: null }),

  favPrivacyPrompt: false,
  setFavPrivacyPrompt: (open) => set({ favPrivacyPrompt: open }),

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

/**
 * Clear the show/episode/discussion selection, for a plain `<Link href="/">`.
 *
 * `selectedPodcast` is module-level and deliberately SURVIVES a client route
 * change — that is the whole mechanism `<FavoritesPage>`'s store-then-navigate
 * handoff runs on, and `<HomePage>`'s mount-time restore early-returns on
 * `if (useApp.getState().selectedPodcast) return;` so the handoff can't be
 * overwritten by a stale URL param.
 *
 * The cost is that a page which ALSO offers an ordinary link back to `/` hands
 * the user their last-opened show instead of the home page: `<HomePage>` never
 * clears the selection on mount, so a link labelled "Go to home" re-enters the
 * detail view and the selection-to-URL mirror then writes `?podcast=<old>` into
 * the address bar. Nothing on screen says why. `goHome()` on the home route
 * clears it in place; every other route needs this on the link itself.
 *
 * Lives here rather than in a component because both `<AppHeader>` and
 * `<FavoritesPage>` need it, and `components/` importing from `components/` is
 * the edge that already produced one module cycle in this repo.
 */
export function clearShowSelection() {
  useApp.getState().selectPodcast(null);
}
