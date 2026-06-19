'use client';
import { useCallback, useEffect, useState } from 'react';
import { SearchBar } from '@/components/search-bar';
import { PodcastResults, EpisodeList, FavoritesList } from '@/components/lists';
import { Player } from '@/components/player';
import { NostrAuth } from '@/components/nostr-auth';
import { GlobalNostrFeed } from '@/components/global-nostr-feed';
import { NostrLiveStreams } from '@/components/nostr-live-streams';
import { DiscussionView } from '@/components/discussion-view';
import { EpisodeDetailView } from '@/components/episode-detail-view';
import { BoltIcon } from '@/components/icons';
import { ThemeToggle } from '@/components/theme-toggle';
import { useApp } from '@/lib/store';
import { resolvePodcastByGuid } from '@/lib/podcast-meta';
import { nip19 } from 'nostr-tools';
import {
  fetchLiveStreamByAddr,
  resolveStreamV4V,
  streamToEpisode,
  streamToPodcast,
  fetchProfile,
} from '@/lib/nostr';

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
  // True while a ?stream=<naddr> deep link is resolving — shows a loading
  // overlay so the user doesn't see the browse page flash before the player.
  const [resolvingStream, setResolvingStream] = useState(false);
  // `selected` lives in the Zustand store so cross-component surfaces (e.g.
  // the podcast-name link in a Nostr note card) can route into the detail
  // view without prop-drilling through the feed components.
  const selected = useApp((s) => s.selectedPodcast);
  const setSelected = useApp((s) => s.selectPodcast);
  const selectedEpisode = useApp((s) => s.selectedEpisode);
  const openEpisode = useApp((s) => s.openEpisode);
  const play = useApp((s) => s.play);
  const setPlayerExpanded = useApp((s) => s.setPlayerExpanded);

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

  // Mount-time hydration: if the URL carries ?stream=<naddr>, fetch that
  // kind:30311 event and open its fullscreen player. One-shot — the param is
  // consumed and cleared so it can't collide with the ?podcast= mirroring below.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const naddr = params.get('stream');
    if (!naddr) return;

    let decoded: ReturnType<typeof nip19.decode> | null = null;
    try { decoded = nip19.decode(naddr); } catch { /* malformed */ }
    if (!decoded || decoded.type !== 'naddr' || decoded.data.kind !== 30311) return;
    const { pubkey, identifier, relays } = decoded.data;

    setResolvingStream(true); // show a loading overlay instead of the browse page
    (async () => {
      try {
        const stream = await fetchLiveStreamByAddr(pubkey, identifier, relays ?? []);
        if (!stream || useApp.getState().current) return;
        // Open the player the moment we have the event — video + chat don't need
        // the profile or value block. Then enrich in the background; episode.id
        // is stable (fnvHash of the stream id) so the second play() doesn't
        // restart the video/hls, it just fills in the host name + boost value.
        play(streamToEpisode(stream, null), streamToPodcast(stream, null));
        setPlayerExpanded(true);
        setResolvingStream(false);
        const [profile, value] = await Promise.all([
          fetchProfile(stream.pubkey).catch(() => null),
          resolveStreamV4V(stream).catch(() => null),
        ]);
        if (useApp.getState().current?.episode.guid === stream.id) {
          play(streamToEpisode(stream, value), streamToPodcast(stream, profile));
        }
      } finally {
        setResolvingStream(false);
        // Clear just the `stream` param, preserving the rest.
        const url = new URL(window.location.href);
        url.searchParams.delete('stream');
        window.history.replaceState({}, '', url.toString());
      }
    })();
  }, [play, setPlayerExpanded]);

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
      {resolvingStream && (
        <div
          className="fixed inset-0 z-40 bg-ink flex flex-col items-center justify-center gap-3 text-muted"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          <span className="text-nostr animate-bolt text-3xl">●</span>
          <span className="text-sm font-mono uppercase tracking-widest">Loading live stream…</span>
        </div>
      )}
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
                  <PodcastResults feeds={publisherAlbums} selected={null} onSelect={setSelected} />
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
