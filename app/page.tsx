'use client';
import { useCallback, useEffect, useState } from 'react';
import { SearchBar } from '@/components/search-bar';
import { PodcastResults, EpisodeList, FavoritesList } from '@/components/lists';
import { NostrAuth } from '@/components/nostr-auth';
import { GlobalNostrFeed } from '@/components/global-nostr-feed';
import { NostrLiveStreams } from '@/components/nostr-live-streams';
import { DiscussionView } from '@/components/discussion-view';
import { EpisodeDetailView } from '@/components/episode-detail-view';
import { BoltIcon } from '@/components/icons';
import { ThemeToggle } from '@/components/theme-toggle';
import { useApp } from '@/lib/store';
import { resolvePodcastByGuid, piMaybeUp, tripPiBreaker } from '@/lib/podcast-meta';
import { useRouter } from 'next/navigation';

import type { Episode, Podcast } from '@/lib/types';

export default function Home() {
  const [feeds, setFeeds] = useState<Podcast[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [favoritesCollapsed, setFavoritesCollapsed] = useState(false);
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
    if (!guid && !feedId) return;
    if (useApp.getState().selectedPodcast) return;
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
      if (!podcast || useApp.getState().selectedPodcast) return;
      setSelected(podcast);
      if (!episodeGuid) return;
      try {
        const res = await fetch(`/api/feed?id=${podcast.id}`);
        const data = await res.json();
        const ep = (data.episodes as Episode[] | undefined)?.find((e) => e.guid === episodeGuid);
        if (!ep) return;
        if (wantDiscussion && ep.socialInteract?.length) {
          if (!useApp.getState().discussionEpisode) openDiscussion(ep);
        } else if (!useApp.getState().selectedEpisode) {
          openEpisode(ep);
        }
      } catch { /* ignore — episode just won't auto-open */ }
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
    if (selected?.podcastGuid) {
      url.searchParams.set('podcast', selected.podcastGuid);
      url.searchParams.delete('feed');
    } else if (selected) {
      url.searchParams.set('feed', String(selected.id));
      url.searchParams.delete('podcast');
    } else {
      url.searchParams.delete('podcast');
      url.searchParams.delete('feed');
    }
    // Discussion is opened from episode detail, so selectedEpisode is usually
    // set; fall back to discussionEpisode for the restored case.
    const episodeForUrl = selectedEpisode ?? discussionEpisode;
    if (episodeForUrl?.guid) url.searchParams.set('episode', episodeForUrl.guid);
    else url.searchParams.delete('episode');
    if (discussionEpisode) url.searchParams.set('discussion', '1');
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
    if (!f.length) setSelected(null);
  }, [setSelected]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const favorites = useApp((s) => s.favorites);
  const hasFavorites = Object.keys(favorites).length > 0;

  const showFavoritesPanel = !query && hasFavorites;
  const showLeftRightLayout = loading || feeds.length > 0 || selected || showFavoritesPanel || !!publisherSource;
  const inDetailView = !!selected;
  const inDiscussion = useApp((s) => !!s.discussionEpisode);
  const inEpisodeDetail = useApp((s) => !!s.selectedEpisode);

  return (
    <main className="min-h-screen pb-32">
      {/* Header */}
      <header className="border-b border-bone/15 sticky top-0 z-20 bg-ink/90 backdrop-blur pt-[env(safe-area-inset-top)]">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center gap-4">
          <button
            type="button"
            onClick={goHome}
            className="flex items-center gap-2 hover:opacity-80 transition"
            aria-label="Go to home"
          >
            <BoltIcon className="w-6 h-6 text-bolt" />
            <span className="font-display text-2xl">Boost Me Bitch</span>
            <span className="text-[10px] text-muted uppercase tracking-widest hidden sm:inline">
              podcasting 2.0
            </span>
          </button>
          <div className="flex-1" />
          <ThemeToggle />
          <NostrAuth />
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-7xl mx-auto px-4 pt-10 pb-6">
        <h2 className="headline text-4xl sm:text-6xl lg:text-7xl drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)]">
          search<span className="text-bolt">.</span>{' '}
          listen<span className="text-bolt">.</span>{' '}
          <span className="text-bolt animate-bolt">boost</span><span className="text-bone">.</span>
        </h2>
        <div className="mt-8 max-w-xl">
          <SearchBar
            key={searchKey}
            onResults={handleResults}
            onLoading={setLoading}
          />
        </div>
      </section>

      {/* Results grid */}
      <section className="max-w-7xl mx-auto px-4 pt-2">
        {inDiscussion ? (
          <DiscussionView />
        ) : inEpisodeDetail ? (
          <EpisodeDetailView />
        ) : inDetailView ? (
          // Detail "page" — once a podcast is picked, the search/favorites
          // aside hides so the episode list + per-podcast Nostr feed get the
          // full viewport. The back button returns the user to whatever
          // panel they were on (search results or favorites are preserved
          // in state).
          <div>
            <button
              onClick={() => setSelected(null)}
              className="btn-ghost text-xs mb-3"
              aria-label="Back"
            >
              ← back to results
            </button>
            <section className="card p-4 min-h-[40vh]">
              <EpisodeList feedId={selected!.id} />
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
            ) : showFavoritesPanel && !query && !loading ? (
              <button
                type="button"
                onClick={() => setFavoritesCollapsed((v) => !v)}
                aria-expanded={!favoritesCollapsed}
                className="w-full text-[11px] uppercase tracking-widest text-muted mb-2 px-1 flex items-center justify-between gap-2 hover:text-bone"
              >
                <span>{Object.keys(favorites).length} favorites</span>
                <span aria-hidden className="text-bone/60">
                  {favoritesCollapsed ? '▸' : '▾'}
                </span>
              </button>
            ) : (
              <div className="text-[11px] uppercase tracking-widest text-muted mb-2 px-1">
                {loading ? 'searching…' : query ? `${feeds.length} feeds` : 'feeds'}
              </div>
            )}
            {!publisherSource && (query || feeds.length > 0 || loading) ? (
              <PodcastResults
                feeds={feeds}
                selected={null}
                onSelect={handleSelect}
              />
            ) : !publisherSource && !query && !loading && !favoritesCollapsed ? (
              <FavoritesList
                selected={null}
                onSelect={setSelected}
              />
            ) : null}
          </aside>
        ) : (
          <EmptyState />
        )}
      </section>

      {!inDetailView && (
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

function EmptyState() {
  return (
    <div className="grid sm:grid-cols-3 gap-4 mt-6">
      {[
        { n: '01', t: 'Search', d: 'Powered by the Podcast Index. V4V-enabled feeds get a yellow stamp.' },
        { n: '02', t: 'Listen', d: 'Full-fidelity playback from the original enclosure URL.' },
        { n: '03', t: 'Boost', d: 'Send sats to the show — auto-split across every value-block recipient, with your message and an optional Nostr post attached.' },
      ].map((step) => (
        <article key={step.n} className="card p-4">
          <div className="font-mono text-bolt text-sm">{step.n}</div>
          <div className="font-display text-xl mt-1">{step.t}</div>
          <p className="text-xs text-muted mt-1.5 leading-relaxed">{step.d}</p>
        </article>
      ))}
    </div>
  );
}
