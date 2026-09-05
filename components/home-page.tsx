'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { SearchBar } from '@/components/search-bar';
import type { SearchInfo } from '@/components/search-bar';
import { Chip } from '@/components/chip';
import { PodcastResults, EpisodeList } from '@/components/lists';
import { FavoritesSyncNotice } from '@/components/favorites-sync-notice';
import { MutesSyncNotice } from '@/components/mutes-sync-notice';
import { AppHeader } from '@/components/app-header';
import Link from 'next/link';
import { useApp } from '@/lib/store';
import { loadEpisodeFromFeed, loadPlaylistPage, resolvePodcastByGuid, piMaybeUp, tripPiBreaker } from '@/lib/podcast-meta';
import { useRouter } from 'next/navigation';
import { SEARCH_TYPES, isMusicMedium, isPlaylistMedium } from '@/lib/util';
import type { SearchType } from '@/lib/util';

import { loadCollection } from '@/lib/playlist-collection';
import type { Podcast } from '@/lib/types';

/**
 * The four heavy surfaces this page can show but usually does not, split out of
 * the first-load bundle.
 *
 * **Each one is already gated by a condition that is FALSE on the first commit,
 * and three of the four are false for the whole life of a deep link** — which
 * is what makes this a code-splitting question rather than a rendering one. The
 * two Nostr sections wait for `entryResolved && !inDetailView`, so a
 * `/?podcast=…` visitor never sees them at all; the episode and discussion views
 * wait for a store field that is null on the server and on the first client
 * render. Statically imported, all four were downloaded, parsed and evaluated
 * before the page could hydrate, on every visit, to render nothing.
 *
 * `ssr: false` costs nothing here for the same reason: not one of them is in
 * the server HTML today, because every gate above is false at that point. So
 * this changes what the browser DOWNLOADS and never what it first paints.
 *
 * The trade is a chunk fetch at the moment each gate first opens. It is paid on
 * the same tick as work these surfaces already do — the two feeds open relay
 * subscriptions, the episode view fetches chapters and a transcript — and
 * `<HomePage>` keeps rendering its own layout around them either way, so no
 * placeholder is needed for something that was blank a moment ago regardless.
 */
const GlobalNostrFeed = dynamic(
  () => import('@/components/global-nostr-feed').then((m) => m.GlobalNostrFeed),
  { ssr: false },
);
const NostrLiveStreams = dynamic(
  () => import('@/components/nostr-live-streams').then((m) => m.NostrLiveStreams),
  { ssr: false },
);
const DiscussionView = dynamic(
  () => import('@/components/discussion-view').then((m) => m.DiscussionView),
  { ssr: false },
);
const EpisodeDetailView = dynamic(
  () => import('@/components/episode-detail-view').then((m) => m.EpisodeDetailView),
  { ssr: false },
);

export function HomePage() {
  const [feeds, setFeeds] = useState<Podcast[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  /**
   * Which lane produced `feeds`, and how many rows the same query has unfiltered.
   *
   * Held beside the results rather than read off the search bar's selector,
   * because the selector moves on the click and the rows do not move until a
   * response lands. Reading the control would let the empty state say "no albums
   * match" over a list of podcasts for the length of one round trip — and the
   * feed-URL branch ignores the selector entirely, so the menu is not even the
   * right answer once the response arrives.
   */
  const [searchInfo, setSearchInfo] = useState<SearchInfo>({ type: 'all', total: 0 });
  /**
   * The content type the search box is CURRENTLY set to — what the user picked
   * in the menu, as opposed to `searchInfo.type`, which is the lane that
   * produced the rows on screen.
   *
   * Lifted out of <SearchBar> because the menu is not its only control: a
   * narrowed search that comes back empty offers a way back to ALL from down in
   * the results panel, and both have to move one piece of state or the selector
   * ends up naming a lane that is no longer running.
   */
  const [searchType, setSearchType] = useState<SearchType>('all');
  const [searchKey, setSearchKey] = useState(0);
  const [publisherSource, setPublisherSource] = useState<Podcast | null>(null);
  const [publisherAlbums, setPublisherAlbums] = useState<Podcast[] | null>(null);
  const [publisherLoading, setPublisherLoading] = useState(false);
  /**
   * "We could not load these" is NOT "there are none", and until there was a
   * button in front of this path both rendered as an empty aside. A publisher
   * whose children we failed to fetch reading as a publisher with no children
   * is the silent-withholding failure CLAUDE.md names — and now that BROWSE
   * PLAYLISTS is one tap from the home page, a Podcast Index outage would have
   * said "ChadF has no playlists" to everybody who pressed it.
   */
  const [publisherError, setPublisherError] = useState(false);
  // **What the publisher feed LISTED, and whether Podcast Index was asked.**
  // `/api/publisher` returns both, and this surface discarded them — so the two
  // faults `<PlaylistsPage>` fixes were still live for anyone arriving through
  // a shared `?publisher=` link or a search hit: every RSS-read child stamped
  // NOT IN PI over feeds PI does hold, and the survivor count printed as the
  // size of the collection. Same route, same body, same repair.
  const [publisherListed, setPublisherListed] = useState(0);
  const [publisherNoPi, setPublisherNoPi] = useState(false);
  const router = useRouter();
  // `selected` lives in the Zustand store so cross-component surfaces (e.g.
  // the podcast-name link in a Nostr note card) can route into the detail
  // view without prop-drilling through the feed components.
  const selected = useApp((s) => s.selectedPodcast);
  const setSelected = useApp((s) => s.selectPodcast);
  const selectedEpisode = useApp((s) => s.selectedEpisode);
  const openEpisode = useApp((s) => s.openEpisode);
  const discussionEpisode = useApp((s) => s.discussionEpisode);
  const openDiscussion = useApp((s) => s.openDiscussion);
  /**
   * Whether we yet know which page this is — the home page, or a `?podcast=` /
   * `?feed=` deep link on its way to a show.
   *
   * **It gates the two relay-backed home surfaces, and it is a load-time rule
   * rather than a rendering preference.** `inDetailView` cannot answer it:
   * it is `!!selectedPodcast`, which a deep link does not set until
   * `resolvePodcastByGuid` has been to the server and back. So on a cold
   * `/?podcast=…&episode=…` the first commit mounted `<NostrLiveStreams>` and
   * `<GlobalNostrFeed>`, whose effects run BEFORE this component's, and threw
   * the whole thing away a moment later. Measured against a stubbed API, both
   * of their index requests went out ahead of the deep link's own first
   * request — and behind an index that answers 503 (or none at all) that is not
   * two requests, it is the full relay path: a kind:1 scan, a reply-tree BFS,
   * the profile ladder and a PI metadata batch, all of it competing for sockets
   * and main-thread time with the page the visitor actually asked for.
   *
   * It starts FALSE on the server and on the first client render, so the markup
   * is deterministic and there is no hydration mismatch — which is why this is
   * a state flag set from an effect rather than a read of
   * `window.location.search` during render. The cost is that an ordinary home
   * visit paints its two feed sections one commit later than it used to; they
   * are below the hero and the search box, and their own skeletons are what
   * appears either way.
   *
   * It is only ever set, never cleared, and that is deliberate: once the URL
   * question is answered `inDetailView` alone governs, so pressing "← back to
   * results" out of a deep-linked show brings the home surfaces up as it always
   * did.
   */
  const [entryResolved, setEntryResolved] = useState(false);

  /**
   * The query string as it was when the page LOADED.
   *
   * A `useRef` initializer runs during render, ahead of every effect, which is
   * the point: the mirror effects rewrite the URL on mount from state that has
   * not hydrated yet, so by the time a restore effect runs, the params it exists
   * to read are already gone. Unlike reading `location` in the render body this
   * never reaches the rendered output, so it cannot cause a hydration mismatch —
   * the reason `entryResolved` is a state flag and this is not.
   *
   * **It sits above the restore effects rather than below them, and the restore
   * below now reads it rather than `window.location.search`.** That was already
   * the documented rule and only the `?publisher=` restore obeyed it; reading
   * live happened to work here because this effect is declared ahead of the
   * mirror. `?t=` removed that luck: the mirror DELETES `t` (a stale one would
   * otherwise sit in the address bar attached to a different episode), so a live
   * read races a rewrite that is now guaranteed to erase the parameter.
   */
  const initialSearch = useRef<string>(
    typeof window === 'undefined' ? '' : window.location.search,
  );

  // Mount-time hydration: restore the detail / episode / discussion view from
  // the URL. Podcast resolves by ?podcast=<guid> (resolvePodcastByGuid, with its
  // own caches + PI breaker) or falls back to ?feed=<id> for shows that have no
  // podcastGuid. ?episode=<guid> opens that episode; +?discussion=1 opens its
  // Nostr thread. Bad/unresolvable params fall back to browse silently.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(initialSearch.current);
    const guid = params.get('podcast');
    const feedId = params.get('feed');
    const playlistParam = params.get('playlist');
    const episodeGuid = params.get('episode');
    const wantDiscussion = params.get('discussion') === '1';
    // ?t=<seconds> — a link to one moment, built by `showShareUrl` from a row of
    // <EpisodeContents>. Anything else drops it, and the link degrades to the
    // plain episode link it otherwise is.
    //
    // The shape is tested BEFORE `Number`, not after, because `Number` accepts
    // far more than any link this app emits — `showShareUrl` writes
    // `String(Math.floor(n))`. It reads `0x64` as 100, `1e3` as 1000 and `''`
    // as 0, so a `Number.isFinite` guard alone starts playback at a position
    // nobody wrote, and a bare `?t=` autoplays from the beginning where an
    // absent one correctly does nothing. The optional fraction stays because a
    // hand-written `t=90.5` is a reasonable thing for a person to type.
    const tRaw = params.get('t')?.trim() ?? '';
    const startSec = /^\d+(\.\d+)?$/.test(tRaw) ? Number(tRaw) : null;
    if (!guid && !feedId && !playlistParam) { setEntryResolved(true); return; }
    if (useApp.getState().selectedPodcast) { setEntryResolved(true); return; }
    // **Every write below has to be able to give up.**
    //
    // This effect runs two network round trips and then writes to the MODULE
    // store, which outlives <HomePage> — so without a cancellation flag a
    // visitor who opens `/?podcast=…&episode=…&t=90` and taps FAVORITES before
    // the resolve lands gets the deep link applied anyway, on a page that is no
    // longer showing it. The `t=` branch is the one that shows: its
    // `!current` guard is still true on a cold load, so the app STARTS PLAYING
    // by itself while the reader is somewhere else. `selectedPodcast` is set
    // too, so a later plain link to `/` reopens that show instead of home.
    //
    // Checked after each await rather than once at the top, because it is the
    // awaits that let the navigation happen.
    let cancelled = false;
    (async () => {
      let podcast: Podcast | null = null;
      // A playlist restores by FEED URL, because a musicL feed Podcast Index has
      // not indexed has no id or guid to restore by — the same reason
      // ?publisher=<feedUrl> exists. `/api/playlist` answers with the channel,
      // so one request both validates the URL and supplies the header.
      if (playlistParam && !guid && !feedId) {
        try {
          // Through `loadPlaylistPage` so the URL is built in one place, and
          // asking for the DEFAULT page rather than a token `limit=1`: it is
          // then byte-identical to the request `<EpisodeList>` makes for page 0
          // a moment later. The two are SEQUENTIAL (this await gates the
          // selection that mounts the list), so the in-flight map cannot
          // collapse them — what does is the route's own `max-age=60`, which
          // makes the second a browser cache hit. A token `limit=1` would have
          // been a third distinct cache key answering nobody.
          podcast = (await loadPlaylistPage({ feedUrl: playlistParam })).podcast ?? null;
        } catch { /* fall back to browse */ }
      } else if (guid) {
        podcast = await resolvePodcastByGuid(guid);
      } else if (feedId) {
        const id = Number(feedId);
        if (Number.isInteger(id) && id > 0 && piMaybeUp()) {
          try {
            const res = await fetch(`/api/feed?id=${id}`);
            if (res.ok) podcast = (await res.json()).podcast ?? null;
            else if (res.status >= 500) tripPiBreaker();
          } catch { /* ignore */ }
        }
      }
      // Whatever happened, the question this flag gates is now answered. On a
      // successful restore `inDetailView` is what hides the home surfaces from
      // here on; on a failure — a guid PI doesn't hold, PI down, offline — the
      // visitor is looking at the browse page and must get the whole one.
      if (cancelled) return;
      setEntryResolved(true);
      if (!podcast || useApp.getState().selectedPodcast) return;
      setSelected(podcast);
      if (!episodeGuid) return;
      // Same lookup the favorites list makes when a favorited episode is
      // tapped — see loadEpisodeFromFeed for why the episode comes out of the
      // feed rather than out of /api/episode-by-guid.
      const loaded = await loadEpisodeFromFeed(podcast.id, episodeGuid);
      if (cancelled || !loaded) return;
      // Enrich the selection with the RSS-derived funding/medium/podroll (the
      // by-guid resolve above doesn't carry them), so a cold deep-link to an
      // episode also shows the SUPPORT link. No-op if it's a different show.
      useApp.getState().syncSelectedPodcast(loaded.podcast);
      const ep = loaded.episode;
      if (!ep) return;
      if (wantDiscussion && ep.socialInteract?.length) {
        if (!useApp.getState().discussionEpisode) openDiscussion(ep);
      } else if (!useApp.getState().selectedEpisode) {
        openEpisode(ep);
      }
      // A moment link starts the episode there. `play` writes `positionSec`
      // before <Player>'s source effect runs, which applies it on
      // `loadedmetadata` — so this is the same path a chapter tap already takes
      // for a not-current episode, not a new one. A browser that blocks the
      // autoplay leaves the episode loaded and parked at `startSec` with
      // <Player> having already flipped `isPlaying` false, so the transport
      // never claims to be playing over silence.
      //
      // The `current` check is the guard every other restore in this effect
      // makes: it settles the StrictMode double-mount, and it stops a replay
      // from yanking playback the visitor has already started.
      if (startSec !== null && !useApp.getState().current) {
        const pod = useApp.getState().selectedPodcast ?? loaded.podcast;
        if (pod) useApp.getState().play(ep, pod, startSec);
      }
    })();
    return () => { cancelled = true; };
  }, [setSelected, openEpisode, openDiscussion]);

  // Back-compat: old shared links used ?stream=<naddr> on the home route.
  // Redirect them to the dedicated /stream/<naddr> page.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const naddr = new URLSearchParams(window.location.search).get('stream');
    if (naddr) router.replace(`/stream/${naddr}`);
  }, [router]);

  // Selection → URL: replaceState so navigation doesn't pile browser history
  // entries (the explicit back buttons are the only in-app exit paths). Lets
  // the SHARE buttons copy real deep links and refresh restore the view.
  // ?podcast=<guid> when the show has one, else ?feed=<id>; +?episode / +?discussion.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    // Preview (not-in-PI) feeds have a synthetic negative id and no guid — they
    // aren't restorable from the URL (a refresh would hit /api/feed?id=<neg> and
    // blank the view), so mirror nothing for them; they're an ephemeral preview.
    const isPreview = !!selected?.isPreview;
    // A PLAYLIST is the one preview feed worth linking to. Every other preview
    // is a publisher checking their own not-yet-submitted feed, but a musicL
    // playlist is a thing people share — and it restores exactly, because
    // `/api/playlist` keys off the feed URL rather than a Podcast Index id.
    const playlistUrl = selected && !selected.podcastGuid && isPlaylistMedium(selected)
      ? selected.url : undefined;
    if (playlistUrl) url.searchParams.set('playlist', playlistUrl);
    else url.searchParams.delete('playlist');
    if (selected?.podcastGuid) {
      url.searchParams.set('podcast', selected.podcastGuid);
      url.searchParams.delete('feed');
    } else if (selected && !isPreview) {
      url.searchParams.set('feed', String(selected.id));
      url.searchParams.delete('podcast');
    } else {
      url.searchParams.delete('podcast');
      url.searchParams.delete('feed');
    }
    // Discussion is opened from episode detail, so selectedEpisode is usually
    // set; fall back to discussionEpisode for the restored case. Skip for
    // preview feeds — the episode can't be re-resolved without a real feed.
    const episodeForUrl = selectedEpisode ?? discussionEpisode;
    if (episodeForUrl?.guid && !isPreview) url.searchParams.set('episode', episodeForUrl.guid);
    else url.searchParams.delete('episode');
    if (discussionEpisode && !isPreview) url.searchParams.set('discussion', '1');
    else url.searchParams.delete('discussion');
    // `t` is a one-shot ARRIVAL parameter, never mirrored: the selection this
    // effect writes from carries no playback position, so there is nothing to
    // re-derive it from and nothing that could keep it honest. Left alone it
    // survives every later selection — opening another episode would leave the
    // previous episode's timestamp in the address bar attached to this one, and
    // a refresh would then start the wrong episode at the wrong second.
    url.searchParams.delete('t');
    window.history.replaceState({}, '', url.toString());
  }, [selected?.podcastGuid, selected?.id, selected, selectedEpisode?.guid, selectedEpisode, discussionEpisode]);

  // Publisher view → ?publisher=<feedUrl>. Separate effect because the publisher
  // aside only renders in browse mode (no podcast/episode selected).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (publisherSource?.url) url.searchParams.set('publisher', publisherSource.url);
    else url.searchParams.delete('publisher');
    window.history.replaceState({}, '', url.toString());
  }, [publisherSource?.url]);

  // Mount-time hydration of the publisher view from ?publisher=<feedUrl>. Detail
  // wins, so skip if a podcast/feed param is present. The publisher record isn't
  // fetched anywhere today, so reconstruct a minimal stub (back-button label
  // shows "Publisher" on a cold restore) and refetch the album list.
  //
  // **It reads the query as it was at LOAD, never `window.location.search`.**
  // The mirror effect directly above is declared first and therefore runs first,
  // and on mount `publisherSource` is null — so it DELETED the param through
  // `replaceState` before this effect ever looked at it. Every `?publisher=`
  // link ever shared opened the plain home page with the address bar silently
  // rewritten. Measured on this branch and on main before the fix.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(initialSearch.current);
    const feedUrl = params.get('publisher');
    // `playlist` belongs in this skip set beside `podcast` and `feed`: all
    // three are a DETAIL the visitor asked for, and the aside is context. It
    // was missing, and this branch never ran at all before the fix above — so
    // `?publisher=…&playlist=…` would newly restore a publisher aside on top of
    // the show the link actually names.
    if (!feedUrl || params.get('podcast') || params.get('feed') || params.get('playlist')) return;
    if (publisherSource) return;
    setPublisherSource({ id: 0, title: 'Publisher', medium: 'publisher', url: feedUrl } as Podcast);
    setPublisherAlbums(null);
    // **A withheld restore must say so.** `piMaybeUp()` reads `bmb:pi:dead`,
    // which is sessionStorage and survives a reload — so a visitor who loaded
    // any page while PI was down and then opened a shared `?publisher=` link in
    // the same tab hit a bare `return`. The mirror effect above has already
    // stripped the param via `replaceState`, so they got the plain home page
    // with the address bar quietly rewritten: indistinguishable from the bug
    // this effect was just written to fix. The source is set first, so the
    // "← Publisher" header and a RETRY are on screen; the retry runs
    // `handleSelect`, which is not gated on the breaker and can still answer
    // from RSS.
    if (!piMaybeUp()) {
      setPublisherError(true);
      setPublisherAlbums([]);
      return;
    }
    setPublisherLoading(true);
    (async () => {
      try {
        const collection = await loadCollection(feedUrl);
        if (!collection) { setPublisherError(true); setPublisherAlbums([]); return; }
        setPublisherAlbums(collection.feeds);
        setPublisherListed(collection.listed);
        setPublisherNoPi(collection.couldNotAskPi);
      } catch { setPublisherError(true); setPublisherAlbums([]); }
      finally { setPublisherLoading(false); }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * What a publisher's children are CALLED.
   *
   * "albums" was hardcoded, and a publisher feed of `musicL` playlists — which
   * is what ChadF's musicL publisher is — then advertised "9 albums" over nine
   * things that are not albums. Derived from what actually came back rather than
   * from the publisher's own medium, because the publisher tag says `publisher`
   * either way and only the children know what they are.
   */
  const publisherChildWord = !publisherAlbums?.length
    ? 'feeds'
    : publisherAlbums.every(isPlaylistMedium)
      ? 'playlists'
      : publisherAlbums.every((p) => isMusicMedium(p))
        ? 'albums'
        : 'feeds';

  function clearPublisher() {
    setPublisherSource(null);
    setPublisherAlbums(null);
    setPublisherLoading(false);
    setPublisherError(false);
  }

  // Referentially stable — it's an effect dependency inside <SearchBar>.
  // An inline arrow here loops: empty query → onResults([], '') → setState →
  // new arrow → effect refires. (setFeeds/setQuery are stable state setters;
  // setSelected is a stable Zustand action.)
  const handleResults = useCallback((f: Podcast[], q: string, info: SearchInfo) => {
    setFeeds(f);
    setQuery(q);
    setSearchInfo(info);
    clearPublisher();
    // Deliberately does NOT change which view is showing — see
    // handleQueryChange. Results arriving is the wrong moment to navigate on:
    // this callback runs for a response the user may have abandoned several
    // keystrokes ago, and `SearchBar`'s generation counter only suppresses
    // OUT-OF-ORDER results, not ones that are still the newest for a query the
    // user has moved on from. Resetting here let the newest response land
    // moments after a click into a show and throw the user back out of it.
  }, []);

  /**
   * A search must LEAVE the drilled-in views, not just refill `feeds` behind
   * them. The results section is a ternary that checks discussion → episode →
   * detail before it ever reaches the branch that renders `feeds`, and the
   * search bar is rendered on all of them — so typing a new query from a show
   * page fetched, matched and stored results that nothing on screen could
   * display. The bar looked dead: the old query stayed in the input, the same
   * show stayed open, and there was no error anywhere to notice.
   *
   * `setSelected(null)` is the one lever that exits all three (selectPodcast
   * clears selectedEpisode and discussionEpisode too). It hangs off the EDIT
   * rather than off the results because the edit is the user's own action:
   * it can't arrive late, and it can't be for a query they've abandoned.
   * Clearing the box is an edit too, which is the old `!f.length` half.
   *
   * Read through getState() rather than the subscribed `selected`, so the
   * callback stays stable and a keystroke on the home page — where there is
   * nothing to leave — doesn't touch the store at all.
   */
  const handleQueryChange = useCallback(() => {
    const st = useApp.getState();
    if (st.selectedPodcast || st.selectedEpisode || st.discussionEpisode) setSelected(null);
  }, [setSelected]);

  /**
   * Changing the content type is an edit of what the query MEANS, so it goes
   * through `handleQueryChange` exactly as a keystroke does.
   *
   * Without that, picking a type from inside a show refetches and refills
   * `feeds` behind a view whose ternary never reaches the branch that renders
   * them — the show stays open, the menu updates, and nothing else moves. That
   * is the same bug the search box itself had before `onQueryChange` existed,
   * and it reads the same way: a dead control.
   *
   * Both callers land here — the menu in <SearchBar> and the empty state's way
   * back to ALL — which is the whole reason this state is lifted.
   */
  const changeType = useCallback((t: SearchType) => {
    setSearchType(t);
    handleQueryChange();
  }, [handleQueryChange]);

  const handleSelect = useCallback(async (p: Podcast) => {
    if (p.medium === 'publisher') {
      setPublisherSource(p);
      setPublisherAlbums(null);
      setPublisherError(false);
      setPublisherListed(0);
      setPublisherNoPi(false);
      setPublisherLoading(true);
      try {
        if (!p.url) { setPublisherAlbums([]); return; }
        const collection = await loadCollection(p.url);
        if (!collection) { setPublisherError(true); setPublisherAlbums([]); return; }
        setPublisherAlbums(collection.feeds);
        setPublisherListed(collection.listed);
        setPublisherNoPi(collection.couldNotAskPi);
      } catch {
        setPublisherError(true);
        setPublisherAlbums([]);
      } finally {
        setPublisherLoading(false);
      }
    } else {
      setSelected(p);
    }
  }, [setSelected]); // eslint-disable-line react-hooks/exhaustive-deps

  function goHome() {
    setFeeds([]);
    setSelected(null);
    setQuery('');
    setLoading(false);
    // The type resets with everything else. `searchKey` remounts the box, so
    // leaving this set would put the app back on the home page with a filter
    // still on and an empty box — and now that the filter is folded into a
    // menu, nothing on screen would be showing it either.
    setSearchType('all');
    setSearchInfo({ type: 'all', total: 0 });
    setSearchKey((n) => n + 1);
    clearPublisher();
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
  }
  // Favorites moved to `/favorites`, and the `mounted` gate this page used to
  // carry went with them: it existed solely because `hasFavorites` fed
  // `showLeftRightLayout`, and lib/store.ts hydrates `favorites` from
  // localStorage at MODULE scope — `{}` on the server, already populated on the
  // client before React hydrates — so a returning user's first client render
  // disagreed with the server HTML and React 19 threw this subtree away. Every
  // term below is in-memory and null on both sides, so the hazard is gone
  // rather than merely moved. The gate now lives in <FavoritesPage>, which is
  // the surface that actually reads those maps.
  /**
   * The vocabulary for the lane that produced what is on screen.
   *
   * Read from `searchInfo`, never from `searchType`: the selector moves on the
   * click and the rows arrive a round trip later, so what the menu names is a
   * claim about the future while these two sentences are claims about the list
   * underneath them.
   */
  const applied = SEARCH_TYPES.find((s) => s.type === searchInfo.type) ?? SEARCH_TYPES[0];
  const resultNoun = applied.noun;

  /**
   * What an empty result set says.
   *
   * Under ALL it is the sentence that has always been there — a genuine "the
   * index did not match this phrase". Under a narrowed type that sentence is
   * FALSE: the
   * index may hold plenty for the query and none of it music, and printing "no
   * results" makes a filter the user applied look like an absence in Podcast
   * Index. It is the same distinction `<FavoritesPage>` draws between a filter
   * that matches nothing and an empty library, and the same reason
   * `<EmptyLibrary>` takes a `degraded` flag: withholding while asserting the
   * opposite is worse than withholding.
   *
   * So the narrowed form names the lane, keeps the true cross-type count on
   * screen, and offers the way out — a control, not a suggestion to go and find
   * one. `total` is only shown when we actually learned it: a fetch that threw
   * reports 0, and an invented number here would be the same kind of confident
   * wrong answer.
   */
  const emptyState = searchInfo.type === 'all' ? undefined : (
    <div className="flex flex-col items-start gap-2">
      <p className="text-muted text-sm">
        No {applied.noun} match “{query}”.
        {searchInfo.total > 0 && ` ${searchInfo.total} result${searchInfo.total === 1 ? '' : 's'} across all types.`}
      </p>
      <Chip active={false} onClick={() => changeType('all')}>
        ← search all types
      </Chip>
    </div>
  );

  /**
   * `query` is in here, and it has to be: without it a search that matches
   * NOTHING takes the whole panel off the screen.
   *
   * The terms were `loading || feeds.length > 0 || …`, so the moment a request
   * settled with no rows the aside stopped rendering — and the aside is what
   * holds both the count line and `<PodcastResults>`' empty state. The result on
   * screen was the hero, the live-streams row, and no acknowledgement of the
   * search at all: the "no results yet" sentence flashed during the fetch and
   * then vanished at exactly the moment it became true. The inner gate one level
   * down has always included `query` for this reason; this one had not.
   *
   * It matters more now, because a narrowed search is a much easier way to reach
   * zero rows, and the sentence that belongs there is the one explaining that a
   * filter — not Podcast Index — is why the list is empty.
   */
  const showLeftRightLayout = loading || !!query || feeds.length > 0 || selected || !!publisherSource;
  const inDetailView = !!selected;
  const showOrigin = useApp((s) => s.showOrigin);
  const inDiscussion = useApp((s) => !!s.discussionEpisode);
  const inEpisodeDetail = useApp((s) => !!s.selectedEpisode);

  return (
    <main className="min-h-screen" style={{ paddingBottom: 'calc(var(--dock-b) + 8rem)' }}>
      {/* Shared with /favorites — see <AppHeader> for why the wordmark is a
          button here and a link everywhere else, and for the 71px it owes
          `--app-header-h`. */}
      <AppHeader onHome={goHome} />

      {/* Hero */}
      <section className="max-w-7xl mx-auto px-4 pt-10 pb-6">
        <h2 className="headline text-4xl sm:text-6xl lg:text-7xl drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)]">
          search<span className="text-bolt">.</span>{' '}
          listen<span className="text-bolt">.</span>{' '}
          <span className="text-bolt animate-bolt">boost</span><span className="text-bone">.</span>
        </h2>
        {/* Load-bearing for Google OAuth verification, not just marketing copy:
            the app home page must "fully describe your app's functionality" and
            "explain with transparency the purpose for which your app requests
            user data". The headline above is three words and carries neither.
            Hidden in the drilled-in views (show / episode / discussion) so it's
            landing copy rather than a permanent banner — deliberately NOT gated
            on `showLeftRightLayout`, because that flips on stored favorites and
            a compliance-critical string shouldn't disappear based on
            localStorage.

            REMOVED ON REQUEST, 2026-08-20: a second sentence naming the
            optional Google sign-in, the Nostr identity it mints, the encrypted
            Drive backup, and that we never see the key or the PIN. That
            sentence was the "purpose for which your app requests user data"
            half of the requirement above, and the app still requests the Drive
            scope — so this page now satisfies the functionality half only.
            app/privacy/page.tsx still carries the full disclosure, which meets
            the separate privacy-policy-URL requirement but is NOT the home-page
            one. If Google re-reviews the consent screen (a re-submission or a
            scope change triggers one), restore it here first. */}
        {!inDetailView && !inEpisodeDetail && !inDiscussion && (
          <p className="mt-4 max-w-xl text-sm leading-relaxed text-bone/80">
            Search Podcasting 2.0 shows, stream episodes, and send Lightning boosts straight
            to creators — no account, no middleman.
          </p>
        )}
        <div className="mt-8 max-w-xl">
          <SearchBar
            key={searchKey}
            type={searchType}
            onTypeChange={changeType}
            onResults={handleResults}
            onLoading={setLoading}
            onQueryChange={handleQueryChange}
          />
          {/* Still here after the favorites panel moved to /favorites, and it
              has to be: hearts render all over this page — search results, the
              podroll, the episode detail view, the layout-mounted fullscreen
              player — so a user toggling one during a degraded read is being
              silently withheld from right here. Its old slot was inside the
              panel that just went away. Unconditional now rather than gated on
              a panel; the component self-hides unless signed in AND degraded. */}
          <div className="mt-3">
            <FavoritesSyncNotice />
            <MutesSyncNotice />
          </div>
          {/* The one curated entry point in the app. It NAVIGATES now — the
              collection is `/playlists`, a page you can bookmark and leave with
              the back button, rather than an aside this page swapped itself
              into behind a `?publisher=` param `replaceState` wrote.
              It renders at EVERY width. It was `lg:hidden` while the header
              carried a `<PlaylistsLink>` from lg: up, the two composing so
              exactly one was on screen; that chip is gone with the rest of the
              header's navigation (see <AppHeader>), and playlists are not a
              tab in <TabBar> — they are content, not a destination — so this
              button and the search box's Playlists lane are the ways in.
              It is discovery, not navigation: it hides as soon as the visitor
              searches or drills in, which is the right shape for a hero button
              and the wrong one for a nav item.
              `entryResolved` costs nothing now that no fetch hangs off the
              press, but it still keeps the button from flashing during a
              `?podcast=` restore that is about to replace this whole hero. */}
          {entryResolved && !inDetailView && !publisherSource && !query && !feeds.length && !loading && (
            <div className="mt-4">
              <Link
                href="/playlists"
                className="btn-ghost btn-compact"
                title="Browse Podcasting 2.0 playlists"
              >
                ♫ BROWSE PLAYLISTS
              </Link>
            </div>
          )}
        </div>
      </section>

      {/* Results grid */}
      <section className="max-w-7xl mx-auto px-4 pt-2">
        {inDiscussion ? (
          <DiscussionView />
        ) : inEpisodeDetail ? (
          <EpisodeDetailView />
        ) : inDetailView ? (
          // Detail "page" — once a podcast is picked, the search aside hides so
          // the episode list + per-podcast Nostr feed get the full viewport.
          //
          // The back control has TWO forms, because a show is no longer only
          // ever opened from this page. `/favorites` and `/npub/<npub>` open
          // one by setting the store and navigating here, and for them
          // "← back to results" named a results list the visitor had never seen
          // while offering no way back to the page they actually came from — a
          // dead end that reads as a broken button. `showOrigin` (lib/store.ts)
          // carries the answer; it is null for every ordinary selection, since
          // `selectPodcast` clears it.
          //
          // The origin form is a real <Link>, so the browser gets a real
          // navigation, and it deliberately does NOT clear the selection: the
          // store is what makes stepping back into the show cheap, and
          // <AppHeader>'s wordmark already clears it on that route.
          <div>
            {showOrigin ? (
              <Link href={showOrigin.path} className="btn-ghost text-xs mb-3 w-fit" aria-label="Back">
                ← back to {showOrigin.label}
              </Link>
            ) : (
              <button
                onClick={() => setSelected(null)}
                className="btn-ghost text-xs mb-3"
                aria-label="Back"
              >
                ← back to results
              </button>
            )}
            <section className="card p-4 min-h-[40vh]">
              <EpisodeList
                feedId={selected!.id}
                feedUrl={selected!.isPreview ? selected!.url : undefined}
                playlistUrl={isPlaylistMedium(selected!) ? selected!.url : undefined}
              />
            </section>
          </div>
        ) : showLeftRightLayout ? (
          // Browse mode: just the aside. Clicking a row flips to detail view
          // (`inDetailView` branch above) so this layer never needs to host
          // an episode pane.
          <aside className="card p-3 max-h-[70vh] overflow-y-auto">
            {publisherSource ? (
              <>
                <button
                  type="button"
                  onClick={clearPublisher}
                  className="btn-ghost text-xs mb-2 px-1"
                >
                  ← {publisherSource.title}
                </button>
                {/* No count while it failed: "0 feeds" over a load error states
                    as fact the very thing we just said we could not determine. */}
                {!publisherError && (
                  <div className="text-[11px] uppercase tracking-widest text-muted mb-2 px-1">
                    {publisherLoading
                      ? `loading ${publisherChildWord}…`
                      // "N of M" whenever children dropped out. The bare number
                      // is a statement about the collection, and the route drops
                      // a child it can neither find in PI nor read from RSS —
                      // right, since one dead entry must not cost the reader the
                      // other nine, but it leaves the survivors indistinguishable
                      // from the whole. Reported as "4 playlists" over a
                      // collection of eleven while PI was rate limiting.
                      : (publisherAlbums?.length ?? 0) < publisherListed
                        ? `${publisherAlbums?.length ?? 0} of ${publisherListed} ${publisherChildWord}`
                        : `${publisherAlbums?.length ?? 0} ${publisherChildWord}`}
                  </div>
                )}
                {publisherLoading ? null : publisherError ? (
                  <p className="text-sm py-4 px-1 flex flex-wrap items-center gap-3">
                    <span className="text-muted">couldn&apos;t load these — check your connection</span>
                    <button
                      type="button"
                      onClick={() => { if (publisherSource) handleSelect(publisherSource); }}
                      className="btn-ghost btn-compact"
                    >
                      ↻ RETRY
                    </button>
                  </p>
                ) : !publisherAlbums?.length ? (
                  // Not "no INDEXED albums": the route reads a child straight
                  // from its RSS when Podcast Index has never seen it. But an
                  // empty list is only "listed nothing" when `listed` is ALSO
                  // zero — otherwise the feed named children and every one of
                  // them failed to resolve, which is the opposite claim.
                  publisherListed > 0 ? null : (
                    <p className="text-muted text-sm py-4 px-1">this publisher feed lists nothing</p>
                  )
                ) : (
                  // `piUnasked`: with PI rate limiting every child comes back
                  // from RSS as `isPreview`, and without this each row is
                  // stamped NOT IN PI — a claim about the feed built out of our
                  // own failure to ask. Reported as "why does it say not in PI
                  // when some are?".
                  <PodcastResults feeds={publisherAlbums} selected={null} piUnasked={publisherNoPi} onSelect={(p) => { clearPublisher(); setSelected(p); }} />
                )}
              </>
            ) : (
              // The noun follows the lane that produced the rows, not what
              // the menu names — "12 albums" has to be true of the twelve rows
              // under it, and during a round trip those two disagree.
              <div className="text-[11px] uppercase tracking-widest text-muted mb-2 px-1">
                {loading ? 'searching…' : query ? `${feeds.length} ${resultNoun}` : 'feeds'}
              </div>
            )}
            {/* Search results only, now that favorites have their own route.
                `showLeftRightLayout` no longer flips on stored favorites, so
                reaching this branch means the user is searching or browsing a
                publisher — there is no third thing for the aside to hold. */}
            {!publisherSource && (query || feeds.length > 0 || loading) ? (
              <PodcastResults
                feeds={feeds}
                selected={null}
                onSelect={handleSelect}
                empty={emptyState}
              />
            ) : null}
          </aside>
        ) : null}
      </section>

      {entryResolved && !inDetailView && (
        <>
          <section className="max-w-7xl mx-auto px-4 pt-8">
            <NostrLiveStreams />
          </section>
          <section className="max-w-7xl mx-auto px-4 pt-12">
            <GlobalNostrFeed />
          </section>
        </>
      )}
    </main>
  );
}
