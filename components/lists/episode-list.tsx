'use client';

// The selected show's header (artwork, value block, SHARE / SUPPORT / BOOST)
// and its episode or track list.

// `shrink-0 whitespace-nowrap` on both branches: .stamp is inline-flex with
// neither, and this sits in a flex row beside a truncating title with no slack,
// so on a phone `● LIVE` wrapped to two lines and blew up the row height.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { Episode, Podcast, ValueBlock } from '@/lib/types';
import type { PlaylistResponse } from '@/lib/podcast-meta';
import { useApp } from '@/lib/store';
import { fmtDate, fmtDuration, fmtLiveTime, scrollBehavior } from '@/lib/format';
import { hasValueRecipients, isMusicMedium, isPlaylistMedium, playsAsTracks, showShareUrl, showStorageKey } from '@/lib/util';
import { storage } from '@/lib/storage';
import { Chip } from '@/components/chip';
import { applyLiveStatuses } from '@/lib/live-status';
import { loadFeed, loadPlaylistPage } from '@/lib/podcast-meta';
import { useLiveStatusPoll } from '@/lib/use-live-status-poll';
import { BoostModal } from '../boost-modal';
import { BoltIcon, CoinIcon } from '../icons';
import { CopyLinkButton } from '../copy-link-button';
import { PodcastCover } from '../podcast-cover';
import { DeferredOnScroll } from '../deferred-on-scroll';
import { FavEpisodeHeart, FavHeart } from '../fav-heart';
import { ValueSplitRows } from '../value-split-rows';
import { useStreamPanel } from '../streaming-settings';

/**
 * The two surfaces below the list, deferred in BYTES as well as on screen.
 *
 * Both already render inside `<DeferredOnScroll>`, which waits for the reader
 * to scroll near them — so the module graph was making every visitor download
 * and parse them up front for something the page deliberately does not show
 * yet. `<DeferredOnScroll>` defers the RENDER; these defer the download, and
 * the two now agree.
 *
 * Measured on a production build: `/` first-load JS 314 kB → 307 kB. It is the
 * larger of the two available cuts here precisely because both of these are the
 * last first-load users of the Nostr note card — a saving that only appeared
 * once `<GlobalNostrFeed>` had been split out of `<HomePage>` as well. That is
 * the shape of this whole bundle: the core is densely shared, so cutting one
 * edge to a module usually saves nothing at all, and cutting the LAST edge
 * saves everything behind it.
 *
 * `ssr: false` costs nothing: `<DeferredOnScroll>` renders its placeholder
 * until an observer fires, so neither of these is ever in the server HTML.
 */
const PodcastNostrFeed = dynamic(
  () => import('../podcast-nostr-feed').then((m) => m.PodcastNostrFeed),
  { ssr: false },
);
const Podroll = dynamic(() => import('../podroll').then((m) => m.Podroll), { ssr: false });

/** Rows revealed per press of "Load more episodes". */
const PAGE_SIZE = 50;

/**
 * How close to the end of a loaded playlist the PLAYING track has to be before
 * the next page is fetched for it. See the effect that reads it.
 */
const PLAYLIST_PREFETCH_RUNUP = 3;

/**
 * What this component tracks about a `musicL` playlist between pages.
 *
 * `nextOffset` is the server's answer and is passed back verbatim; the counts
 * ACCUMULATE across pages, because the sentence under the list speaks for
 * everything loaded so far, not for the last press.
 */
interface PlaylistMeta {
  feedUrl: string;
  nextOffset: number | null;
  total: number;
  notFound: number;
  couldNotAsk: number;
  /**
   * The show this playlist was built from — see `PlaylistResponse.sourceShow`.
   *
   * Read from page 0 and NOT accumulated, unlike the counts above: it is a
   * property of the playlist, so every page reports the same string and a later
   * page has nothing to add. It stays on `PlaylistMeta` rather than in its own
   * state because it arrives on the same response and must not be able to
   * disagree with the rows it captions.
   */
  sourceShow?: string | null;
}

function LiveBadge({ status }: { status: NonNullable<Episode['liveStatus']> }) {
  if (status === 'live') {
    return (
      <span className="stamp shrink-0 whitespace-nowrap text-nostr border-nostr/60 bg-nostr/10 animate-bolt">
        ● LIVE
      </span>
    );
  }
  if (status === 'pending') {
    return <span className="stamp shrink-0 whitespace-nowrap text-bolt border-bolt/60">PENDING</span>;
  }
  return null;
}

function ShareButton({ podcast }: { podcast: Podcast }) {
  return (
    <CopyLinkButton
      url={showShareUrl(podcast.podcastGuid)}
      title="Copy link to this show"
      className="btn-ghost btn-compact"
    />
  );
}

// <podcast:funding> — the host's non-Lightning support link (Patreon, etc.),
// shown next to the V4V BOOST button. Uses the first funding entry; its message
// is the tooltip. Renders nothing when the feed carries no funding tag.
function SupportButton({ podcast }: { podcast: Podcast }) {
  const funding = podcast.funding?.[0];
  if (!funding?.url) return null;
  return (
    <a
      href={funding.url}
      target="_blank"
      rel="noopener noreferrer"
      className="btn-ghost btn-compact"
      title={funding.message || 'Support this show'}
    >
      <CoinIcon /> SUPPORT
    </a>
  );
}

function ValueBlockDetails({ value }: { value: ValueBlock }) {
  const suggestedSats =
    value.suggested && Number.isFinite(parseFloat(value.suggested))
      ? Math.round(parseFloat(value.suggested) * 100_000_000)
      : null;

  return (
    <div className="border-b border-bone/15 pb-4 mb-1">
      <div className="text-[11px] uppercase tracking-widest text-muted pt-3 pb-2 flex items-center justify-between gap-4 flex-wrap">
        <span>value-block splits ({value.type} · {value.method})</span>
        {suggestedSats !== null && (
          <span className="text-bolt">suggested: {suggestedSats} sats / min</span>
        )}
      </div>
      <ValueSplitRows value={value} />
    </div>
  );
}

export function EpisodeList({
  feedId,
  feedUrl,
  playlistUrl,
}: {
  feedId: number | null;
  feedUrl?: string;
  /**
   * Set when the CALLER already knows this feed is a `musicL` playlist, which
   * skips a round trip: `/api/feed` would answer with a correct-looking show
   * carrying zero rows, because a playlist's tracks are channel-level remote
   * items that route cannot resolve. When it isn't set the effect below still
   * recovers — an empty musicL answer is the same signal, one request later —
   * so a caller that doesn't know the medium yet is not broken, only slower.
   */
  playlistUrl?: string;
}) {
  // `truncated`: the route could not serve the whole feed (PI's per-feed
  // ceiling, or the response byte budget). Rendered at the end of the list —
  // a list that just stops reads as a show that stopped.
  const [data, setData] = useState<{ podcast: Podcast | null; episodes: Episode[]; truncated?: boolean }>({
    podcast: null, episodes: [],
  });
  const [loading, setLoading] = useState(false);
  // A failed load used to fall through to the `not found` branch below, which
  // says the show doesn't exist when what actually happened is that the network
  // dropped. Separate state, separate message, and a way back.
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Generation counter for the feed fetch — the same guard lib/nostr/use-feed.ts
  // and components/podroll.tsx already use. See the effect below for why this
  // one is not merely a render optimisation.
  const feedGenRef = useRef(0);
  const [showBoostOpen, setShowBoostOpen] = useState(false);
  const [boostTrack, setBoostTrack] = useState<Episode | null>(null);
  const [valueOpen, setValueOpen] = useState(false);
  // Episodes open at 10 rows and reveal PAGE_SIZE more per press of a "Load
  // more" button. The Nostr comments feed sits below this list, so a button
  // (not infinite scroll) keeps it at a stable, reachable position on mobile —
  // which is also why the step is bigger than the opening count: /api/feed
  // serves up to PI's full 1000 items, and 10 at a time is a hundred presses
  // to reach the bottom of an archive show.
  const [visibleCount, setVisibleCount] = useState(10);
  /**
   * Playlist paging state. A `musicL` feed publishes no `<item>` elements, so
   * its rows are RESOLVED one Podcast Index lookup at a time and "load more" is
   * a real request rather than the pure reveal above.
   *
   * `nextOffset` comes from the server and is used verbatim — see
   * `loadPlaylistPage`. Deriving it here from `episodes.length` would skip
   * tracks the moment the server's dedupe or ref cap removed any.
   */
  const [playlist, setPlaylist] = useState<PlaylistMeta | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Consecutive-miss counters for the two-misses-before-ended rule in
  // applyLiveStatuses — keyed per feedId so a stale count from the previous
  // show can't end an item on this one's very first poll.
  const liveMissesRef = useRef<Record<string, number>>({});
  const play = useApp((s) => s.play);
  const togglePlay = useApp((s) => s.togglePlay);
  const isPlaying = useApp((s) => s.isPlaying);
  const current = useApp((s) => s.current);
  const openEpisode = useApp((s) => s.openEpisode);
  const setEpisodeQueue = useApp((s) => s.setEpisodeQueue);
  const syncSelectedPodcast = useApp((s) => s.syncSelectedPodcast);

  useEffect(() => {
    setValueOpen(false);
    setVisibleCount(10);
    // All three reset together with `visibleCount`: a total carried over from
    // the previous show would render a "load more" for tracks this one doesn't
    // have, and a stale `loadingMore` would leave the button dead.
    setPlaylist(null);
    setLoadingMore(false);
    setPageError(false);
    liveMissesRef.current = {};
    // setLoading(false) matters on this branch: it returns before the fetch
    // below, so a `loading` left true by a PREVIOUS run was never cleared and
    // the render — which checks `loading` first — sat on "loading episodes…"
    // forever. Reachable whenever a favorite hasn't resolved an id yet, which
    // is exactly the state a slow or failed metadata fetch leaves behind.
    if (!feedId) { setData({ podcast: null, episodes: [] }); setLoading(false); setLoadError(false); return; }
    setLoading(true);
    // The generation guard is a CORRECTNESS gate, not a perf one. Switching
    // shows quickly can land A's response after B's, and the handler below
    // writes `episodeQueue` — the array <TransportControls> computes prev/next
    // from and playNext() traverses. A late response therefore repointed the
    // transport at the previous show while this one was on screen.
    //
    // The `.catch` is the other half. `.finally` does NOT handle rejection, so
    // an offline fetch, a 5xx serving an HTML body, or any r.json() parse
    // failure was an unhandled promise rejection: loading cleared, data stayed
    // empty, and the page rendered `not found`.
    const gen = ++feedGenRef.current;
    setLoadError(false);
    // `loadFeed` rather than a bare fetch, and it also owns the URL: a preview
    // (not-in-PI) feed loads by URL because its synthetic id cannot be resolved
    // server-side, and a PI feed by numeric id. It coalesces a request already
    // in flight for the same feed — which on a cold `?podcast=…&episode=…` deep
    // link is exactly what is happening, because `<HomePage>` puts the show in
    // the store first and this list mounts while `loadEpisodeFromFeed` is still
    // downloading the very same body. Nothing is cached past the promise
    // settling, so the retry button below still re-fetches.
    // Page 0 of a playlist, applied exactly as a feed response would be.
    const applyFirstPage = (p: PlaylistResponse, podcast: Podcast) => {
      const eps = Array.isArray(p.episodes) ? p.episodes : [];
      setData({ podcast, episodes: eps, truncated: false });
      // No setEpisodeQueue here — one effect derives it from the DISPLAY order,
      // because the order can also change without a load (the toggle).
      syncSelectedPodcast(podcast);
      setPlaylist({
        feedUrl: podcast.url ?? '',
        nextOffset: p.nextOffset ?? null,
        total: p.total ?? eps.length,
        notFound: p.notFound ?? 0,
        couldNotAsk: p.couldNotAsk ?? 0,
        sourceShow: p.sourceShow ?? null,
      });
    };

    (async () => {
      try {
        if (playlistUrl) {
          const p = await loadPlaylistPage({ feedUrl: playlistUrl });
          if (gen !== feedGenRef.current) return;
          if (!p?.podcast) { setLoadError(true); return; }
          applyFirstPage(p, p.podcast);
          return;
        }
        const d = await loadFeed(feedUrl ? { feedUrl } : { feedId });
        if (gen !== feedGenRef.current) return;
        // An `{ error }` body parses fine and would otherwise put `undefined`
        // into the store as the episode queue.
        const episodes = Array.isArray(d?.episodes) ? d.episodes : [];
        if (!d?.podcast) { setLoadError(true); return; }
        // A musicL feed answering with no rows is NOT an empty show — its
        // tracks are channel-level `<podcast:remoteItem>` entries, which
        // /api/feed does not resolve. `/api/feed?id=` backfills `medium` from
        // the RSS channel parse, so this is reached even when Podcast Index
        // (which does not reliably index the tag) gave us nothing to go on.
        // `episodes.length` is part of the test on purpose: a hybrid feed that
        // declares musicL and ALSO publishes real items keeps its items.
        if (!episodes.length && isPlaylistMedium(d.podcast) && d.podcast.url) {
          const p = await loadPlaylistPage({ feedUrl: d.podcast.url });
          if (gen !== feedGenRef.current) return;
          if (p?.podcast) { applyFirstPage(p, p.podcast); return; }
        }
        setData({ podcast: d.podcast, episodes, truncated: !!d.truncated });
        // The queue is derived from the DISPLAY order by an effect below, not
        // written here: the order can change without a load (the toggle), and
        // two writers would let the two disagree.
        // Push the RSS-enriched podcast (funding/medium/podroll) back into the
        // store so the episode detail view — which reads selectedPodcast — shows
        // the SUPPORT link the show page gets. No-op if it's a different show.
        syncSelectedPodcast(d.podcast);
      } catch {
        if (gen === feedGenRef.current) setLoadError(true);
      } finally {
        if (gen === feedGenRef.current) setLoading(false);
      }
    })();
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      containerRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    }
    // `reloadKey` is what the retry button below bumps — it re-runs this effect
    // without needing the feed to change.
  }, [feedId, feedUrl, playlistUrl, reloadKey, syncSelectedPodcast]);

  // Above the early returns — hook order has to stay stable, and the hook
  // itself no-ops (returns nulls) while the podcast is still null.
  const { button: streamButton, panel: streamPanel } = useStreamPanel(
    data.podcast,
    hasValueRecipients(data.podcast?.value),
  );

  // A live item's status is fixed at load time otherwise: /api/feed is fetched
  // once per feedId and nothing asks again. Polls only while this feed has a
  // live item on screen, and patches liveStatus/liveStartTime in place —
  // `syncSelectedPodcast` is deliberately NOT re-fired, so playback is
  // undisturbed.
  //
  // `episodeQueue` IS re-derived now, because it hangs off `data.episodes`
  // rather than being written here (see the effect below). That is harmless
  // where re-running `syncSelectedPodcast` would not be: the patch keeps every
  // episode id, and `playNext`/`<TransportControls>` locate the current track by
  // `findIndex` on id rather than by a stored index, so a fresh array with the
  // same ids costs one re-render and changes nothing about where ⏭ goes.
  const hasLiveItem = data.episodes.some((e) => !!e.liveStatus && e.liveStatus !== 'ended');
  useLiveStatusPoll(feedId, hasLiveItem, (items) => {
    // Plain read of `data` (not a setData updater): useLiveStatusPoll refreshes
    // its callback ref on every render, so this closure is always the latest by
    // the time a poll actually fires — and computing the ref mutation outside
    // setState avoids double-counting misses under React 18 Strict Mode's
    // double-invoke of updater functions.
    const { episodes, misses } = applyLiveStatuses(data.episodes, items, liveMissesRef.current);
    liveMissesRef.current = misses;
    if (episodes !== data.episodes) setData((prev) => ({ ...prev, episodes }));
  });

  /**
   * Which way round this show's list runs, and the key it is remembered under.
   *
   * Seeded in an EFFECT rather than a `useState` lazy initializer. This
   * component reaches routes that are server-rendered, and reading storage
   * during the first render is the module-scope-vs-server mismatch
   * `<FavoritesPage>`'s `mounted` gate exists for — React 19 throws the subtree
   * away and rebuilds it. An effect is the cheaper form of that gate: the first
   * render is deterministic and the stored value lands on the next commit.
   *
   * Keyed on the SHOW, so opening a second show does not inherit the first
   * one's order — and the `false` in the else branch is what makes that true
   * rather than leaving the previous show's flag standing.
   */
  const [oldestFirst, setOldestFirst] = useState(false);
  const showKey = data.podcast ? showStorageKey(data.podcast) : '';
  useEffect(() => {
    setOldestFirst(showKey ? storage.episodeOrder.getShow(showKey) === 'oldest' : false);
  }, [showKey]);

  /**
   * The list as it is DISPLAYED — and the array everything downstream reads.
   *
   * **Only the non-live tail reverses.** `/api/feed` sorts in three tiers: live,
   * then pending, then the feed's own order (date desc, or disc/track asc on an
   * album). A whole-array `.reverse()` would drop a live broadcast to the bottom
   * of the page and put the "Live & upcoming" heading under the episodes it
   * introduces, because those dividers are computed from adjacency in the
   * rendered slice. A live show is the most time-sensitive thing this list can
   * hold; the order toggle is about the archive behind it.
   *
   * **Never a playlist.** Its pages are FETCHED, so the array here is a prefix
   * of the real list and reversing it would both misrepresent the list and make
   * "load more" append into the middle. The control is hidden there, and this
   * re-checks rather than trusting that — a flag left over from the previous
   * show would otherwise reverse the first playlist opened after it.
   *
   * Memoized because it feeds `setEpisodeQueue` below: a fresh array every
   * render would rewrite the store every render.
   */
  const orderedEpisodes = useMemo(() => {
    const eps = data.episodes;
    if (!oldestFirst || !data.podcast || isPlaylistMedium(data.podcast)) return eps;
    const live = eps.filter((e) => !!e.liveStatus);
    const rest = eps.filter((e) => !e.liveStatus);
    // `[...x].reverse()`, never an in-place reverse: `data.episodes` is state.
    return [...live, ...[...rest].reverse()];
  }, [data.episodes, data.podcast, oldestFirst]);

  /**
   * `episodeQueue` follows the DISPLAY, so ⏭ always means "the row below".
   *
   * One effect rather than a write at each of the three places `data.episodes`
   * is set, because the order can change after any of them — flipping the
   * toggle is not a load. Deriving it here means the queue cannot disagree with
   * the screen, which is the whole property: reversed, episode 1 is at the top,
   * and a queue still in feed order would leave ⏭ with nowhere to go from it.
   *
   * The generation guard the loaders carry is still what protects this: it
   * gates `setData`, and this only ever reflects whatever `data` settled on.
   */
  useEffect(() => {
    setEpisodeQueue(orderedEpisodes);
  }, [orderedEpisodes, setEpisodeQueue]);

  /**
   * Fetch the next page of a playlist while the listener is still on this one.
   *
   * **Auto-advance ends at the end of the QUEUE, and on a playlist the queue is
   * a page rather than the list.** A feed hands over every episode at once, so
   * "the last row" really is the last one; a `musicL` playlist is resolved a
   * page at a time — one Podcast Index lookup per track — so without this,
   * playback stops at track 50 of 300 with a LOAD MORE TRACKS button the
   * listener cannot see, having put the phone down. That is the same silence
   * the auto-advance fix exists to remove, arriving one page later.
   *
   * Hung off what is PLAYING, not off scrolling, and gated on the playing item
   * being in this queue: a page is a real request against our Podcast Index
   * quota, so it is spent for somebody who is listening through the list, never
   * for a page sitting open in a background tab. Three rows of run-up is enough
   * at any ordinary track length and small enough that a listener who stops
   * early has cost nothing.
   *
   * `loadingMore` is what stops it repeating: it is set synchronously by
   * `loadNextPage`, so the re-renders between the press and the response bail
   * here, and once the page lands the run-up is 50 rows again.
   */
  useEffect(() => {
    if (!playlist || playlist.nextOffset == null || loadingMore) return;
    if (!current) return;
    const idx = orderedEpisodes.findIndex((e) => e.id === current.episode.id);
    if (idx < 0 || orderedEpisodes.length - idx > PLAYLIST_PREFETCH_RUNUP) return;
    loadNextPage();
    // `loadNextPage` is a function declaration and so is new on every render;
    // listing it would run this effect every render for no gain. Everything it
    // reads is in the list below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlist, loadingMore, current, orderedEpisodes]);

  function toggleOrder() {
    const next = !oldestFirst;
    setOldestFirst(next);
    if (showKey) storage.episodeOrder.setShow(showKey, next);
    // Same reason <FavoritesPage>'s reveal reset includes its sort: after a
    // flip, "revealed 200" names a different 200, and re-mounting that many
    // covers against arbitrary third-party artwork is the byte cost the pager
    // exists to bound.
    setVisibleCount(10);
  }

  if (!feedId) {
    return (
      <div ref={containerRef} className="text-muted text-sm py-12 text-center px-4 border border-dashed border-bone/15">
        <span className="lg:hidden">select a podcast above to see episodes</span>
        <span className="hidden lg:inline">select a podcast on the left to see episodes</span>
      </div>
    );
  }
  if (loading) return <div ref={containerRef} className="text-muted text-sm py-8">loading episodes…</div>;
  // A dropped connection is not the same answer as "this show doesn't exist",
  // and telling a user the second when the first happened sends them looking
  // for a problem that isn't there.
  if (loadError) {
    return (
      <div ref={containerRef} className="text-sm py-8 flex flex-wrap items-center gap-3">
        <span className="text-muted">couldn&apos;t load this show — check your connection</span>
        <button type="button" className="btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
          ↻ retry
        </button>
      </div>
    );
  }
  if (!data.podcast) return <div ref={containerRef} className="text-muted text-sm py-8">not found</div>;

  const showHasValue = hasValueRecipients(data.podcast.value);
  const isMusic = isMusicMedium(data.podcast);
  const isPlaylist = isPlaylistMedium(data.podcast);
  // A row here is a TRACK on both, so it plays on tap and the header cover is a
  // play button. `isMusic` alone keeps the two things a playlist must NOT do:
  // render every row at once, and sort by track number.
  const asTracks = playsAsTracks(data.podcast);

  /**
   * Fetch the next page of a playlist and APPEND it.
   *
   * The generation counter is read at press time and re-checked on resolve, for
   * the same reason the load effect gives: this writes `episodeQueue`, the array
   * `<TransportControls>` and `playNext` walk, so a response that lands after
   * the user has moved to another show must not be applied.
   *
   * `setData` gets the MERGED array, never the page — the queue is derived from
   * it, and a queue holding only the newest page would strand a listener who is
   * playing a track from an earlier one, with ⏭ doing nothing.
   */
  function loadNextPage() {
    if (!playlist || playlist.nextOffset == null || loadingMore) return;
    const gen = feedGenRef.current;
    const offset = playlist.nextOffset;
    setLoadingMore(true);
    setPageError(false);
    loadPlaylistPage({ feedUrl: playlist.feedUrl, offset })
      .then((p) => {
        if (gen !== feedGenRef.current) return;
        const page = Array.isArray(p?.episodes) ? p.episodes : [];
        if (!p?.podcast) { setPageError(true); return; }
        // An updater so `merged` is computed off the freshest `prev` rather
        // than off a closure captured at click time. It no longer writes the
        // queue from in here — that is derived from `data` — which also removes
        // the Strict-Mode question the write used to have to answer.
        setData((prev) => ({ ...prev, episodes: [...prev.episodes, ...page] }));
        setPlaylist((prev) => (prev ? {
          ...prev,
          nextOffset: p.nextOffset ?? null,
          total: p.total ?? prev.total,
          notFound: prev.notFound + (p.notFound ?? 0),
          couldNotAsk: prev.couldNotAsk + (p.couldNotAsk ?? 0),
        } : prev));
      })
      .catch(() => { if (gen === feedGenRef.current) setPageError(true); })
      .finally(() => { if (gen === feedGenRef.current) setLoadingMore(false); });
  }
  // First non-pending track IN DISPLAY ORDER — normally track 1 of an album,
  // and the last track when the list is reversed, because the header's ▶ has to
  // start where the list starts or the button contradicts the rows under it. An
  // unresolved playlist placeholder has no enclosure, so it can never be the
  // thing that button starts.
  const firstPlayable =
    orderedEpisodes.find((e) => e.liveStatus !== 'pending' && !e.unresolved)
    ?? orderedEpisodes.find((e) => !e.unresolved);
  // Is the currently-playing track part of this show?
  const showIsCurrent = !!current && (
    (!!data.podcast.podcastGuid && current.podcast.podcastGuid === data.podcast.podcastGuid) ||
    current.podcast.id === data.podcast.id
  );
  // Music feeds show the whole album (track order); other shows paginate 10 at a
  // time. A PLAYLIST renders everything it has fetched, because on that path the
  // fetch IS the page — a second reveal axis on top would make one new track
  // cost two presses.
  // Slices the ORDERED array, never the raw one: slicing first and reversing
  // after would show the last ten of the first ten.
  // A playlist is paged by FETCH, so the array here is a prefix of the real
  // list; one row has no order to choose. Both are "no choice, no control".
  const canReverse = !isPlaylist && orderedEpisodes.filter((e) => !e.liveStatus).length > 1;
  const visibleEpisodes = isMusic || isPlaylist ? orderedEpisodes : orderedEpisodes.slice(0, visibleCount);
  const remaining = orderedEpisodes.length - visibleEpisodes.length;

  return (
    <div ref={containerRef}>
      {/* NOT sticky on phones. Pinned, this header plus the app header held 282px
          of an 844px viewport — a third of the screen — and tracks scrolled
          underneath the album art, reading as three stacked layers fighting each
          other. It earns its keep on desktop, where it's ~156px of 900+ and the
          tracklist is long; on a phone it just eats the content.
          `top-` MUST stay sm:-prefixed: `top` on a *relative* element offsets it
          rather than pinning it, so an unprefixed value would shove the whole
          header a header's-height down the page.
          `gap-x-4` keeps the original 16px cover-to-text gap; `gap-y-3`
          reproduces the `mt-3` that came OFF the action cluster when it was
          hoisted out of the text column below. */}
      <header className="relative sm:sticky sm:top-[var(--app-header-h)] z-10 bg-ink/90 backdrop-blur -mx-4 px-4 flex flex-wrap items-start gap-x-4 gap-y-3 pb-4 border-b border-bone/15">
        {asTracks && firstPlayable ? (
          <button
            type="button"
            onClick={() => {
              if (showIsCurrent) togglePlay();
              else if (data.podcast) play(firstPlayable, data.podcast);
            }}
            className="group relative w-20 h-20 flex-shrink-0"
            title={showIsCurrent && isPlaying ? 'Pause' : 'Play album'}
            aria-label={showIsCurrent && isPlaying ? 'Pause' : 'Play album'}
          >
            <PodcastCover
              image={data.podcast.image}
              artwork={data.podcast.artwork}
              title={data.podcast.title}
              seed={data.podcast.podcastGuid ?? String(data.podcast.id)}
              className="w-full h-full border border-bone/20 group-hover:border-bolt text-3xl"
            />
            <div
              className={`absolute inset-0 grid place-items-center bg-ink/45 transition pointer-events-none text-2xl ${
                showIsCurrent && isPlaying ? 'text-bolt' : 'text-bone group-hover:text-bolt group-hover:bg-ink/55'
              }`}
            >
              {showIsCurrent && isPlaying ? '❚❚' : '▶'}
            </div>
          </button>
        ) : (
          <PodcastCover
            image={data.podcast.image}
            artwork={data.podcast.artwork}
            title={data.podcast.title}
            seed={data.podcast.podcastGuid ?? String(data.podcast.id)}
            className="w-20 h-20 border border-bone/20 flex-shrink-0 text-3xl"
          />
        )}
        <div className="min-w-0 flex-1">
          {/* text-lg on phones is sized to the COLUMN, not chosen for looks: the
              cover eats 80px + a 16px gap, leaving ~244px, and one long word
              ("Deprogramming") plus its article overflows that at text-xl and
              above — which orphaned "The" on its own line and pushed the rest
              past the clamp, ellipsizing an ordinary album title. The clamp
              bounds a STICKY header, so it has to stay, but at this size three
              lines hold ~60 characters before anything is lost. */}
          <h2 className="font-display text-lg sm:text-3xl leading-tight font-semibold break-words line-clamp-3 sm:line-clamp-none">
            {data.podcast.title}
          </h2>
          <p className="text-sm text-muted mt-1">{data.podcast.author}</p>
          {/* Both stamps share one wrapper. They are `inline-flex` and each used
              to carry its own `mt-2`, so a preview feed that ALSO has a value
              block rendered them separated by nothing but a JSX whitespace node
              — which collides at 326px. */}
          {(data.podcast.isPreview || data.podcast.value) && (
            <div className="flex flex-wrap items-center gap-2 mt-2">
              {data.podcast.isPreview && (
                <span
                  className="stamp text-muted border-muted/40"
                  title="This feed isn't in Podcast Index — parsed directly from RSS for preview"
                >
                  NOT IN PI · PREVIEW
                </span>
              )}
              {data.podcast.value && (
                <button
                  type="button"
                  onClick={() => setValueOpen((v) => !v)}
                  className="stamp text-bolt border-bolt/60 hover:bg-bolt/10 transition cursor-pointer"
                  aria-expanded={valueOpen}
                  title={valueOpen ? 'Hide split details' : 'Show split details'}
                >
                  ⚡ {data.podcast.value.recipients?.length ?? 0} recipients
                  <span className="ml-1">{valueOpen ? '▾' : '▸'}</span>
                </button>
              )}
            </div>
          )}
        </div>
        {/* A `basis-full` SIBLING of the text column, not a child of it. DOM
            nesting can't be responsive, and nested under the author line this
            cluster is capped at ~230px on a 390px screen — which stacks five
            ~105px controls one-per-line into a ragged column. As a basis-full
            sibling it claims the header's whole width at every breakpoint (the
            header is `flex-wrap` for exactly this). Order is documented in
            docs/ui.md; all five controls stay, none hide behind a menu. */}
        <div className="basis-full flex flex-wrap items-center gap-2">
          <FavHeart podcast={data.podcast} size="md" />
          <ShareButton podcast={data.podcast} />
          <SupportButton podcast={data.podcast} />
          {streamButton}
          {showHasValue && (
            <button
              onClick={() => setShowBoostOpen(true)}
              className="btn-bolt btn-compact"
              title="Boost the show"
            >
              <BoltIcon /> BOOST
            </button>
          )}
        </div>
      </header>
      {streamPanel && (
        <div className="px-4 sm:px-6 pb-4 border-b border-bone/10">{streamPanel}</div>
      )}
      {valueOpen && data.podcast.value && (
        <ValueBlockDetails value={data.podcast.value} />
      )}
      {/* The order toggle, and the truncation warning that only exists when it
          is on.

          ABOVE the list rather than in the header cluster above it: that row is
          the show's five actions and is already measured tight at 390px, and
          docs/ui.md says all five stay and none collapse into a menu — a sixth
          control there means re-measuring the whole cluster.

          Hidden on a playlist (its pages are fetched, so there is no full list
          to reverse) and on a list too short to have an order at all, which is
          <RailPicker>'s rule: no choice, no control. */}
      {canReverse && (
        <div className="flex flex-wrap items-center gap-2 py-3">
          <Chip
            active={oldestFirst}
            onClick={toggleOrder}
            title={oldestFirst ? 'Show newest first' : 'Show oldest first'}
          >
            {oldestFirst ? '↑ oldest first' : '↓ newest first'}
          </Chip>
          {/* THE NOTICE MOVES, and that is the point rather than a nicety.
              Newest-first, a truncated feed simply ends early and the sentence
              belongs at the bottom, where the reader arrives at it. Reversed,
              the episodes we could not fetch are the ones BEFORE the first row —
              so the list opens on "the oldest we could reach" while looking
              exactly like episode 1, and the sentence explaining that would sit
              at the far end of a list nobody has scrolled. It is also ungated
              here: the bottom copy waits for every row to be revealed, which is
              the wrong moment for a claim the very first screen is making. */}
          {oldestFirst && data.truncated && (
            <p className="text-muted text-xs basis-full">
              This isn&apos;t the start of the show — it&apos;s longer than the app can load in
              one go, so the earliest episodes aren&apos;t here.
            </p>
          )}
        </div>
      )}
      <ul className="divide-y divide-bone/10">
        {visibleEpisodes.map((e, idx) => {
          // Two flags, because they answer different questions. `playing` is
          // identity — "is this row the current item" — and it drives the row
          // tint and keeps the artwork's control visible while paused.
          // `isThisPlaying` is the transport state, and only the glyph and the
          // labels may read it: an identity-only glyph draws ❚❚ over a paused
          // episode, which is the icon lying about what a press will do.
          const playing = current?.episode.id === e.id;
          const isThisPlaying = playing && isPlaying;
          const prev = idx > 0 ? visibleEpisodes[idx - 1] : null;
          const isFirstLive = !!e.liveStatus && (!prev || !prev.liveStatus);
          const isFirstRegular = !e.liveStatus && !!prev?.liveStatus;
          // A playlist's `<podcast:txt purpose="episode">` caption, rendered
          // once above the run of tracks it introduces. Derived from the SLICED
          // array like the two dividers above, and a plain comparison with the
          // previous row — which is what makes it survive "load more" appending
          // a page with no extra state.
          const groupHead = e.playlistGroup && e.playlistGroup !== prev?.playlistGroup
            ? e.playlistGroup : null;
          // What a press on the row itself does. Named because it now has TWO
          // mounts: the <li>'s tap area, and the real <button> around the title
          // block below. It was inline on the <li> alone, and that made the
          // `openEpisode` branch — the whole detail view, with the show notes,
          // chapters, transcript and discussion — reachable only with a
          // pointer. The artwork button beside it covers PLAY, so the gap was
          // invisible from the keyboard: the row appeared usable and simply
          // could not be opened.
          const openRow = () => {
            // Tracks carry little extra metadata, so a row tap just plays
            // the track rather than opening the episode detail view.
            // An unresolved playlist row has an EMPTY enclosure, so it must
            // do neither: playing it puts a dead track in the player, and
            // its detail page would be blank.
            if (e.unresolved) return;
            if (asTracks) {
              if (e.liveStatus === 'pending' || !data.podcast) return;
              // THE SAME BRANCH THE ARTWORK BUTTON USES, and the row must
              // not be the exception. `play()` on the current item sets
              // `positionSec: 0`, so on a STALLED track — the buffer-starved
              // case player.tsx's `stalledRef` branch exists for — the
              // reload it triggers reads that zero and restarts the song
              // from the top, while the artwork button two elements away
              // resumes where the listener was. One press, two behaviours,
              // on one row.
              if (playing) togglePlay();
              else play(e, data.podcast);
            } else {
              openEpisode(e);
            }
          };
          return (
            <Fragment key={e.id}>
              {/* The show NAMES the episode, because the episode title alone
                  does not say what it is. These markers are bare titles —
                  "Saddle Up", "Cycles", "FM Rodeo" — and above a run of songs
                  they read as random words; reported 2026-08-29 as "I see the
                  name but it looks random". The show comes from the playlist's
                  own `<podcast:txt purpose="source-feed">`, so it is the
                  document's answer rather than one derived from the playlist
                  title. It degrades to the bare title when that feed could not
                  be read, which is the state this shipped in. Some playlists
                  need it less than others — ITDV writes "Episode 72 - Miles for
                  miles", which says what it is already — but the qualifier is
                  not worth branching on per feed. */}
              {groupHead && (
                <li className="text-[10px] uppercase tracking-[0.18em] text-muted pt-4 pb-1 border-b-0 break-words">
                  {playlist?.sourceShow && (
                    <span className="text-bone/70">{playlist.sourceShow} · </span>
                  )}
                  {groupHead}
                </li>
              )}
              {isFirstLive && (
                <li className="text-[10px] uppercase tracking-[0.18em] text-muted pt-3 pb-1 border-b-0">
                  Live &amp; upcoming
                </li>
              )}
              {isFirstRegular && (
                <li className="text-[10px] uppercase tracking-[0.18em] text-muted pt-4 pb-1 border-b-0">
                  Episodes
                </li>
              )}
            <li
              className={`group transition ${
                playing ? 'bg-bolt/10' : 'hover:bg-bone/5'
              } cursor-pointer`}
              onClick={openRow}
            >
              <div className="flex gap-2 sm:gap-3 py-3 pr-1 sm:pr-3">
              {/* An unresolved playlist row has an empty enclosure, so the
                  play control is SUPPRESSED rather than disabled — a disabled
                  button still says "there is a track here to play". */}
              {e.unresolved ? (
                <div className="relative w-12 h-12 flex-shrink-0">
                  <PodcastCover
                    image={undefined}
                    artwork={undefined}
                    title={e.title || '?'}
                    seed={e.guid ?? String(e.id)}
                    className="w-full h-full border border-dashed border-bone/25 opacity-50 text-base"
                  />
                </div>
              ) : (
              /* A control drawing ❚❚ has to pause. Calling `play()` on the
                 current item is a silent no-op: it writes `isPlaying: true`
                 over `true`, so neither the player's [isPlaying] effect nor its
                 [current.episode.id] source effect re-runs, and the press does
                 nothing at all. Same branch the album header above and
                 <EpisodeDetailView> already use. */
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (e.liveStatus === 'pending') return;
                  if (playing) togglePlay();
                  else if (data.podcast) play(e, data.podcast);
                }}
                disabled={e.liveStatus === 'pending'}
                className="relative w-12 h-12 flex-shrink-0 disabled:cursor-not-allowed"
                title={
                  e.liveStatus === 'pending' ? 'Not started yet'
                  : isThisPlaying ? 'Pause'
                  : playing ? 'Resume'
                  : 'Play'
                }
                aria-label={isThisPlaying ? 'Pause' : playing ? 'Resume' : 'Play'}
              >
                <PodcastCover
                  image={e.image}
                  artwork={e.feedImage || data.podcast?.artwork}
                  title={e.title}
                  seed={e.guid ?? String(e.id)}
                  className="w-full h-full border border-bone/40 group-hover:border-bolt text-base"
                />
                {/* The SCRIM follows identity and the GLYPH follows the
                    transport, which is why this differs from the album header
                    above. Gating the scrim on `isThisPlaying` too would fade
                    the control out the moment the listener paused — no visible
                    way back, on the one row they are most likely to press. */}
                {e.liveStatus !== 'pending' && (
                  <div
                    className={`absolute inset-0 grid place-items-center bg-ink/55 transition pointer-events-none ${
                      playing
                        ? 'opacity-100 text-bolt'
                        : 'opacity-0 group-hover:opacity-100 text-bone group-hover:text-bolt'
                    }`}
                  >
                    {isThisPlaying ? '❚❚' : '▶'}
                  </div>
                )}
              </button>
              )}
              {/* The title block is the row's keyboard control. It carries the
                  SAME handler as the <li>, and stops propagation so a pointer
                  press does not run it twice — the shape every other inner
                  control on this row already uses. `disabled` on an unresolved
                  row because `openRow` is a no-op there, and a focusable
                  control that does nothing is worse than none.

                  Deliberately NOT an aria-label: the button's text content is
                  the episode title plus its date and duration, which is the
                  accessible name we want. */}
              <button
                type="button"
                onClick={(ev) => { ev.stopPropagation(); openRow(); }}
                disabled={!!e.unresolved}
                className="min-w-0 flex-1 text-left disabled:cursor-default"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {e.liveStatus && <LiveBadge status={e.liveStatus} />}
                  <div className={`text-base font-display font-medium leading-tight truncate ${e.unresolved ? 'text-muted italic' : ''}`}>
                    {e.unresolved
                      ? (e.unresolved === 'not-found' ? 'Track not in Podcast Index' : 'Track not looked up')
                      : e.title}
                  </div>
                </div>
                {/* Wraps, deliberately NOT truncates: at ~150px the date and
                    duration fit line 1 and `· ⚡ V4V` drops to line 2, whereas a
                    truncate here would silently eat the V4V signal. Without the
                    wrap these spans couldn't shrink below their content and
                    painted out sideways under the BOOST button. */}
                <div className="text-xs text-muted flex flex-wrap gap-x-2 gap-y-0.5 min-w-0 mt-0.5">
                  {e.liveStatus && e.liveStartTime ? (
                    <span className="whitespace-nowrap">
                      {e.liveStatus === 'pending' ? 'starts ' : 'started '}
                      {fmtLiveTime(e.liveStartTime)}
                    </span>
                  ) : (
                    e.datePublished && (
                      <span className="whitespace-nowrap">
                        {fmtDate(e.datePublished)}
                      </span>
                    )
                  )}
                  {e.duration && <span className="whitespace-nowrap">· {fmtDuration(e.duration)}</span>}
                  {e.value && <span className="text-bolt whitespace-nowrap">· ⚡ V4V</span>}
                  {/* The curator's `<podcast:txt purpose="playcount">` marker.
                      Per ROW rather than as a heading like `playlistGroup`: the
                      Greatest Hits list runs to 1,800 tracks and its bottom
                      group ("2 plays") is 800 rows long, so a heading is off
                      screen for almost every row it describes. */}
                  {e.playlistPlays && (
                    <span className="whitespace-nowrap">
                      · {e.playlistPlays} {e.playlistPlays === 1 ? 'play' : 'plays'}
                    </span>
                  )}
                </div>
                {/* These were bare inline <span>s carrying `mt-0.5`, which does
                    nothing on a non-replaced inline element, and they abutted
                    with only a JSX whitespace node between them when both ran. */}
                {e.socialInteract?.length || e.valueTimeSplits?.length ? (
                  <div className="flex flex-wrap items-center gap-x-2 text-[11px] mt-0.5">
                    {e.socialInteract?.length ? (
                      <span className="text-nostr">💬 discussion</span>
                    ) : null}
                    {e.valueTimeSplits?.length ? (
                      <span className="text-bolt">⚡ {e.valueTimeSplits.length} tracks</span>
                    ) : null}
                  </div>
                ) : null}
              </button>
              {hasValueRecipients(e.value) && (
                // Icon-only below sm: — the word cost ~100px of a ~314px row and
                // left the title ~24px ("Vi…", "Co…"). aria-label is REQUIRED
                // now, not decorative: `title` is not an accessible name, so
                // without it this button reads as unlabelled once the word goes.
                <button
                  type="button"
                  onClick={(ev) => { ev.stopPropagation(); setBoostTrack(e); }}
                  className="btn-bolt btn-compact self-center flex-shrink-0 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0"
                  title="Boost this track"
                  aria-label="Boost this track"
                >
                  <BoltIcon />
                  <span className="hidden sm:inline">BOOST</span>
                </button>
              )}
              <div className="self-center flex-shrink-0">
                <FavEpisodeHeart episode={e} podcast={data.podcast} />
              </div>
              </div>
            </li>
            </Fragment>
          );
        })}
      </ul>
      {remaining > 0 && (
        <button
          type="button"
          onClick={() => setVisibleCount((c) => Math.min(c + PAGE_SIZE, data.episodes.length))}
          className="btn-ghost w-full mt-3"
        >
          Load more episodes ({remaining})
        </button>
      )}
      {/* Not when reversed — the same fact is already stated above the list,
          where the missing episodes actually are. Printing it here too would
          point at the newest end and say "older episodes exist" about the
          direction the reader is heading away from. */}
      {remaining === 0 && data.truncated && !oldestFirst && (
        <p className="text-muted text-xs mt-3 text-center">
          Older episodes exist, but this feed is longer than the app can load in one go.
        </p>
      )}

      {/* Playlist paging. Unlike the button above, this one FETCHES: a musicL
          feed's tracks are resolved a page at a time, one Podcast Index lookup
          each. `nextOffset` is the server's answer and is never recomputed here. */}
      {playlist && playlist.nextOffset != null && (
        <button
          type="button"
          onClick={loadNextPage}
          disabled={loadingMore}
          className="btn-ghost w-full mt-3 disabled:opacity-60"
        >
          {loadingMore
            ? 'loading tracks…'
            : `Load more tracks (${playlist.total - data.episodes.length} of ${playlist.total} left)`}
        </button>
      )}
      {pageError && (
        <p className="text-sm mt-3 flex flex-wrap items-center justify-center gap-3">
          <span className="text-muted">couldn&apos;t load more tracks — check your connection</span>
          <button type="button" onClick={loadNextPage} className="btn-ghost btn-compact">↻ RETRY</button>
        </p>
      )}
      {/* Say what is missing. Both counts describe everything loaded so far, and
          they are SEPARATE sentences because they are separate claims: Podcast
          Index answering "I don't have this" is settled, while never getting an
          answer is not a fact about the track at all — which is why only the
          second offers a retry. Collapsing them would tell somebody a track does
          not exist because our own rate limit was hit. */}
      {playlist && playlist.notFound > 0 && (
        <p className="text-muted text-xs mt-3 text-center">
          {playlist.notFound} of the {data.episodes.length} tracks loaded aren&apos;t in Podcast Index yet.
        </p>
      )}
      {playlist && playlist.couldNotAsk > 0 && (
        <p className="text-xs mt-2 flex flex-wrap items-center justify-center gap-3">
          <span className="text-muted">
            {playlist.couldNotAsk} track{playlist.couldNotAsk === 1 ? '' : 's'} couldn&apos;t be looked
            up — that isn&apos;t an answer about them.
          </span>
          <button type="button" onClick={() => setReloadKey((n) => n + 1)} className="btn-ghost btn-compact">
            ↻ RETRY
          </button>
        </p>
      )}

      {/* No placeholder: <Podroll> renders its own skeleton while resolving and
          nothing at all if no entry resolves, so a placeholder heading here
          would flash in and then vanish. */}
      {data.podcast.podroll?.length ? (
        <DeferredOnScroll>
          <Podroll items={data.podcast.podroll} />
        </DeferredOnScroll>
      ) : null}

      {data.podcast.podcastGuid && (
        <DeferredOnScroll
          placeholder={
            <h3 className="font-display text-lg mt-8 text-muted">
              <span className="text-nostr">#</span> Boosts &amp; chatter on Nostr
              {data.podcast.title ? (
                <span className="text-muted text-sm"> · {data.podcast.title}</span>
              ) : null}
            </h3>
          }
        >
          <PodcastNostrFeed
            podcastGuid={data.podcast.podcastGuid}
            podcastTitle={data.podcast.title}
            episodeGuids={
              // A playlist is excluded on purpose: these guids belong to OTHER
              // feeds' items, so asking for this feed's per-episode chatter with
              // them would pull in notes about somebody else's album.
              isMusic
                ? data.episodes.map((e) => e.guid).filter((g): g is string => !!g)
                : undefined
            }
          />
        </DeferredOnScroll>
      )}

      {showBoostOpen && data.podcast && showHasValue && (
        <BoostModal
          podcast={data.podcast}
          onClose={() => setShowBoostOpen(false)}
        />
      )}

      {boostTrack && data.podcast && (
        <BoostModal
          episode={boostTrack}
          podcast={data.podcast}
          onClose={() => setBoostTrack(null)}
        />
      )}

    </div>
  );
}
