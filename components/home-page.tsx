'use client';
import { useCallback, useEffect, useState } from 'react';
import { SearchBar } from '@/components/search-bar';
import { PodcastResults, EpisodeList } from '@/components/lists';
import { FavoritesSyncNotice } from '@/components/favorites-sync-notice';
import { GlobalNostrFeed } from '@/components/global-nostr-feed';
import { NostrLiveStreams } from '@/components/nostr-live-streams';
import { DiscussionView } from '@/components/discussion-view';
import { EpisodeDetailView } from '@/components/episode-detail-view';
import { AppHeader } from '@/components/app-header';
import Link from 'next/link';
import { useApp } from '@/lib/store';
import { loadEpisodeFromFeed, resolvePodcastByGuid, piMaybeUp, tripPiBreaker } from '@/lib/podcast-meta';
import { useRouter } from 'next/navigation';

import type { Podcast } from '@/lib/types';

export function HomePage() {
  const [feeds, setFeeds] = useState<Podcast[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [searchKey, setSearchKey] = useState(0);
  const [publisherSource, setPublisherSource] = useState<Podcast | null>(null);
  const [publisherAlbums, setPublisherAlbums] = useState<Podcast[] | null>(null);
  const [publisherLoading, setPublisherLoading] = useState(false);
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

  // Mount-time hydration: restore the detail / episode / discussion view from
  // the URL. Podcast resolves by ?podcast=<guid> (resolvePodcastByGuid, with its
  // own caches + PI breaker) or falls back to ?feed=<id> for shows that have no
  // podcastGuid. ?episode=<guid> opens that episode; +?discussion=1 opens its
  // Nostr thread. Bad/unresolvable params fall back to browse silently.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const guid = params.get('podcast');
    const feedId = params.get('feed');
    const episodeGuid = params.get('episode');
    const wantDiscussion = params.get('discussion') === '1';
    if (!guid && !feedId) { setEntryResolved(true); return; }
    if (useApp.getState().selectedPodcast) { setEntryResolved(true); return; }
    (async () => {
      let podcast: Podcast | null = null;
      if (guid) {
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
      setEntryResolved(true);
      if (!podcast || useApp.getState().selectedPodcast) return;
      setSelected(podcast);
      if (!episodeGuid) return;
      // Same lookup the favorites list makes when a favorited episode is
      // tapped — see loadEpisodeFromFeed for why the episode comes out of the
      // feed rather than out of /api/episode-by-guid.
      const loaded = await loadEpisodeFromFeed(podcast.id, episodeGuid);
      if (!loaded) return;
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
    })();
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
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const feedUrl = params.get('publisher');
    if (!feedUrl || params.get('podcast') || params.get('feed')) return;
    if (publisherSource || !piMaybeUp()) return;
    setPublisherSource({ id: 0, title: 'Publisher', medium: 'publisher', url: feedUrl } as Podcast);
    setPublisherAlbums(null);
    setPublisherLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/publisher?feedUrl=${encodeURIComponent(feedUrl)}`);
        if (res.status >= 500) { tripPiBreaker(); setPublisherAlbums([]); return; }
        setPublisherAlbums((await res.json()).feeds ?? []);
      } catch { setPublisherAlbums([]); }
      finally { setPublisherLoading(false); }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function clearPublisher() {
    setPublisherSource(null);
    setPublisherAlbums(null);
    setPublisherLoading(false);
  }

  // Referentially stable — it's an effect dependency inside <SearchBar>.
  // An inline arrow here loops: empty query → onResults([], '') → setState →
  // new arrow → effect refires. (setFeeds/setQuery are stable state setters;
  // setSelected is a stable Zustand action.)
  const handleResults = useCallback((f: Podcast[], q: string) => {
    setFeeds(f);
    setQuery(q);
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

  const handleSelect = useCallback(async (p: Podcast) => {
    if (p.medium === 'publisher') {
      setPublisherSource(p);
      setPublisherAlbums(null);
      setPublisherLoading(true);
      try {
        if (!p.url) { setPublisherAlbums([]); return; }
        const res = await fetch(`/api/publisher?feedUrl=${encodeURIComponent(p.url)}`);
        const data = await res.json();
        setPublisherAlbums(data.feeds ?? []);
      } catch {
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
  // rather than merely moved. The gate now lives in <FavoritesPage> and
  // <FavoritesLink>, which are the surfaces that actually read those maps.
  const showLeftRightLayout = loading || feeds.length > 0 || selected || !!publisherSource;
  const inDetailView = !!selected;
  const showOrigin = useApp((s) => s.showOrigin);
  const inDiscussion = useApp((s) => !!s.discussionEpisode);
  const inEpisodeDetail = useApp((s) => !!s.selectedEpisode);

  return (
    <main className="min-h-screen pb-32">
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
          </div>
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
              <EpisodeList feedId={selected!.id} feedUrl={selected!.isPreview ? selected!.url : undefined} />
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
                <div className="text-[11px] uppercase tracking-widest text-muted mb-2 px-1">
                  {publisherLoading ? 'loading albums…' : `${publisherAlbums?.length ?? 0} albums`}
                </div>
                {publisherLoading ? null : !publisherAlbums?.length ? (
                  <p className="text-muted text-sm py-4 px-1">no indexed albums found</p>
                ) : (
                  <PodcastResults feeds={publisherAlbums} selected={null} onSelect={(p) => { clearPublisher(); setSelected(p); }} />
                )}
              </>
            ) : (
              <div className="text-[11px] uppercase tracking-widest text-muted mb-2 px-1">
                {loading ? 'searching…' : query ? `${feeds.length} feeds` : 'feeds'}
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
