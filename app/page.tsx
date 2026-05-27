'use client';
import { useEffect, useState } from 'react';
import { SearchBar } from '@/components/search-bar';
import { PodcastResults, EpisodeList, FavoritesList } from '@/components/lists';
import { Player } from '@/components/player';
import { NostrAuth } from '@/components/nostr-auth';
import { GlobalNostrFeed } from '@/components/global-nostr-feed';
import { DiscussionView } from '@/components/discussion-view';
import { DeferredOnScroll } from '@/components/deferred-on-scroll';
import { BoltIcon } from '@/components/icons';
import { ThemeToggle } from '@/components/theme-toggle';
import { useApp } from '@/lib/store';
import { resolvePodcastByGuid } from '@/lib/podcast-meta';

import type { Podcast } from '@/lib/types';

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

  // Mount-time hydration: if the URL carries ?podcast=<guid>, resolve it once
  // and flip into the detail view. resolvePodcastByGuid has its own caches +
  // PI circuit-breaker, so a bad/unresolvable guid just falls back to the
  // browse view silently.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const guid = new URLSearchParams(window.location.search).get('podcast');
    if (!guid) return;
    if (useApp.getState().selectedPodcast) return;
    resolvePodcastByGuid(guid).then((p) => {
      if (p && !useApp.getState().selectedPodcast) setSelected(p);
    });
  }, [setSelected]);

  // Selection → URL: replaceState so podcast navigation doesn't pile entries
  // into browser history (the explicit "back to results" button remains the
  // only in-app way back). Lets the SHARE button copy a real deep link.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (selected?.podcastGuid) url.searchParams.set('podcast', selected.podcastGuid);
    else url.searchParams.delete('podcast');
    window.history.replaceState({}, '', url.toString());
  }, [selected?.podcastGuid]);

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
            onResults={(f, q) => { setFeeds(f); setQuery(q); if (!f.length) setSelected(null); }}
            onLoading={setLoading}
          />
        </div>
      </section>

      {/* Results grid */}
      <section className="max-w-7xl mx-auto px-4 pt-2">
        {inDiscussion ? (
          <DiscussionView />
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
          <DeferredOnScroll
            placeholder={
              <h2 className="font-display text-2xl text-muted">
                <span className="text-nostr">#</span> Global boost feed
              </h2>
            }
          >
            <GlobalNostrFeed />
          </DeferredOnScroll>
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
