'use client';
import { useCallback, useEffect, useState } from 'react';
import { SearchBar } from '@/components/search-bar';
import { PodcastResults, EpisodeList, FavoritesList } from '@/components/lists';
import { Player } from '@/components/player';
import { NostrAuth } from '@/components/nostr-auth';
import { GlobalNostrFeed } from '@/components/global-nostr-feed';
import { DiscussionView } from '@/components/discussion-view';
import { EpisodeDetailView } from '@/components/episode-detail-view';
import { BoltIcon } from '@/components/icons';
import { ThemeToggle } from '@/components/theme-toggle';
import { useApp } from '@/lib/store';
import { resolvePodcastByGuid } from '@/lib/podcast-meta';

import type { Episode, Podcast } from '@/lib/types';

export default function Home() {
  const [feeds, setFeeds] = useState<Podcast[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [favoritesCollapsed, setFavoritesCollapsed] = useState(false);
  const [searchKey, setSearchKey] = useState(0);
  // `selected` lives in the Zustand store so cross-component surfaces (e.g.
  // the podcast-name link in a Nostr note card) can route into the detail
  // view without prop-drilling through the feed components.
  const selected = useApp((s) => s.selectedPodcast);
  const setSelected = useApp((s) => s.selectPodcast);
  const selectedEpisode = useApp((s) => s.selectedEpisode);
  const openEpisode = useApp((s) => s.openEpisode);

  // Mount-time hydration: if the URL carries ?podcast=<guid> (+ optional
  // ?episode=<guid>), resolve and open both. resolvePodcastByGuid has its own
  // caches + PI circuit-breaker, so bad/unresolvable guids fall back silently.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const guid = params.get('podcast');
    const episodeGuid = params.get('episode');
    if (!guid) return;
    if (useApp.getState().selectedPodcast) return;
    resolvePodcastByGuid(guid).then(async (p) => {
      if (!p || useApp.getState().selectedPodcast) return;
      setSelected(p);
      if (!episodeGuid) return;
      try {
        const res = await fetch(`/api/feed?id=${p.id}`);
        const data = await res.json();
        const ep = (data.episodes as Episode[] | undefined)?.find((e) => e.guid === episodeGuid);
        if (ep && !useApp.getState().selectedEpisode) openEpisode(ep);
      } catch { /* ignore — episode just won't auto-open */ }
    });
  }, [setSelected, openEpisode]);

  // Selection → URL: replaceState so navigation doesn't pile browser history
  // entries (the explicit back buttons are the only in-app exit paths). Lets
  // the SHARE buttons copy real deep links.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (selected?.podcastGuid) url.searchParams.set('podcast', selected.podcastGuid);
    else url.searchParams.delete('podcast');
    if (selectedEpisode?.guid) url.searchParams.set('episode', selectedEpisode.guid);
    else url.searchParams.delete('episode');
    window.history.replaceState({}, '', url.toString());
  }, [selected?.podcastGuid, selectedEpisode?.guid]);

  // Referentially stable — it's an effect dependency inside <SearchBar>.
  // An inline arrow here loops: empty query → onResults([], '') → setState →
  // new arrow → effect refires. (setFeeds/setQuery are stable state setters;
  // setSelected is a stable Zustand action.)
  const handleResults = useCallback((f: Podcast[], q: string) => {
    setFeeds(f);
    setQuery(q);
    if (!f.length) setSelected(null);
  }, [setSelected]);

  function goHome() {
    setFeeds([]);
    setSelected(null);
    setQuery('');
    setLoading(false);
    setSearchKey((n) => n + 1);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
  }
  const favorites = useApp((s) => s.favorites);
  const hasFavorites = Object.keys(favorites).length > 0;

  const showFavoritesPanel = !query && hasFavorites;
  const showLeftRightLayout = loading || feeds.length > 0 || selected || showFavoritesPanel;
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
            {showFavoritesPanel && !query && !loading ? (
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
            {query || feeds.length > 0 || loading ? (
              <PodcastResults
                feeds={feeds}
                selected={null}
                onSelect={setSelected}
              />
            ) : favoritesCollapsed ? null : (
              <FavoritesList
                selected={null}
                onSelect={setSelected}
              />
            )}
          </aside>
        ) : (
          <EmptyState />
        )}
      </section>

      {!inDetailView && (
        <section className="max-w-7xl mx-auto px-4 pt-12">
          <GlobalNostrFeed />
        </section>
      )}

      <Player />
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
