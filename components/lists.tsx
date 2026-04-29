'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Episode, Podcast, FavoritePodcast, ValueBlock } from '@/lib/types';
import { useApp } from '@/lib/store';
import { resolvePublishRelays, schedulePublishFavorites } from '@/lib/nostr';
import { BoostModal } from './boost-modal';
import { BoltIcon } from './icons';
import { PodcastNostrFeed } from './podcast-nostr-feed';

function FavHeart({ podcast }: { podcast: Podcast }) {
  const guid = podcast.podcastGuid;
  const isFav = useApp((s) => s.isFavorite(guid));
  const addFavorite = useApp((s) => s.addFavorite);
  const removeFavorite = useApp((s) => s.removeFavorite);
  const identity = useApp((s) => s.identity);

  if (!guid) return null; // can't favorite a podcast without a canonical GUID

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (isFav) {
      removeFavorite(guid!);
    } else {
      const fav: FavoritePodcast = {
        id: podcast.id,
        podcastGuid: guid!,
        title: podcast.title,
        author: podcast.author,
        image: podcast.image,
        url: podcast.url,
        addedAt: Date.now(),
      };
      addFavorite(fav);
    }
    if (identity) {
      schedulePublishFavorites(
        () => Object.keys(useApp.getState().favorites),
        resolvePublishRelays(identity),
      );
    }
  }

  return (
    <button
      onClick={toggle}
      aria-label={isFav ? 'Unfavorite' : 'Favorite'}
      title={
        identity
          ? (isFav ? 'Unfavorite (synced to Nostr)' : 'Favorite (syncs to Nostr)')
          : (isFav ? 'Unfavorite' : 'Favorite (sign in with Nostr to sync)')
      }
      className={`flex-shrink-0 transition text-lg leading-none ${
        isFav ? 'text-nostr' : 'text-bone/40 hover:text-nostr'
      }`}
    >
      {isFav ? '♥' : '♡'}
    </button>
  );
}

// One row used by both the search-results panel and the favorites panel.
// `showV4VStamp` is on for search results (where the value-block is known)
// and off for favorites (the cache only carries metadata, not value).
function PodcastRow({
  podcast,
  selected,
  onSelect,
  showV4VStamp,
}: {
  podcast: Podcast;
  selected: boolean;
  onSelect: (p: Podcast) => void;
  showV4VStamp: boolean;
}) {
  return (
    <li
      onClick={() => onSelect(podcast)}
      className={`flex gap-3 py-3 px-1 cursor-pointer group transition ${
        selected ? 'bg-bolt/10' : 'hover:bg-bone/5'
      }`}
    >
      {podcast.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={podcast.image} alt="" className="w-14 h-14 object-cover border border-bone/20 flex-shrink-0" />
      ) : (
        <div className="w-14 h-14 border border-bone/20 bg-line flex-shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-display text-base leading-tight truncate">{podcast.title}</span>
          {showV4VStamp && podcast.value && (
            <span className="stamp text-bolt border-bolt/60">⚡ V4V</span>
          )}
        </div>
        <div className="text-xs text-muted truncate">{podcast.author}</div>
      </div>
      <FavHeart podcast={podcast} />
    </li>
  );
}

export function PodcastResults({
  feeds,
  selected,
  onSelect,
}: {
  feeds: Podcast[];
  selected: number | null;
  onSelect: (p: Podcast) => void;
}) {
  if (!feeds.length) {
    return <p className="text-muted text-sm py-8 px-1">no results yet — try another phrase</p>;
  }
  return (
    <ul className="divide-y divide-bone/10">
      {feeds.map((p) => (
        <PodcastRow
          key={p.id}
          podcast={p}
          selected={selected === p.id}
          onSelect={onSelect}
          showV4VStamp
        />
      ))}
    </ul>
  );
}

export function FavoritesList({
  selected,
  onSelect,
}: {
  selected: number | null;
  onSelect: (p: Podcast) => void;
}) {
  const favorites = useApp((s) => s.favorites);
  const list = useMemo(
    () =>
      Object.values(favorites).sort((a, b) => b.addedAt - a.addedAt),
    [favorites],
  );

  if (!list.length) return null;

  return (
    <ul className="divide-y divide-bone/10">
      {list.map((p) => {
        // FavoritePodcast → Podcast: the cache doesn't carry the value block,
        // so the value-aware stamp is hidden via showV4VStamp={false}.
        const minimal: Podcast = {
          id: p.id,
          podcastGuid: p.podcastGuid,
          title: p.title,
          author: p.author,
          image: p.image,
          url: p.url,
        };
        return (
          <PodcastRow
            key={p.podcastGuid}
            podcast={minimal}
            selected={selected === p.id}
            onSelect={onSelect}
            showV4VStamp={false}
          />
        );
      })}
    </ul>
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
      <ul className="space-y-2">
        {value.recipients.map((r, i) => {
          const isLnAddr = r.type === 'lnaddress';
          const addr =
            isLnAddr || r.address.length <= 20
              ? r.address
              : `${r.address.slice(0, 8)}…${r.address.slice(-8)}`;
          return (
            <li key={i} className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap text-sm">
                  <span className="font-display">
                    {r.name?.trim() || <span className="text-muted">(unnamed)</span>}
                  </span>
                  {r.fee && <span className="stamp text-muted border-bone/30">fee</span>}
                </div>
                <div className="text-[11px] text-muted font-mono break-all">
                  {addr}
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="font-display text-sm text-bolt">{r.split}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function EpisodeList({ feedId, feedUrl }: { feedId: number | null; feedUrl?: string | null }) {
  const [data, setData] = useState<{ podcast: Podcast | null; episodes: Episode[] }>({
    podcast: null, episodes: [],
  });
  const [loading, setLoading] = useState(false);
  const [showBoostOpen, setShowBoostOpen] = useState(false);
  const [valueOpen, setValueOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const play = useApp((s) => s.play);
  const current = useApp((s) => s.current);

  useEffect(() => {
    setValueOpen(false);
    if (!feedId && !feedUrl) { setData({ podcast: null, episodes: [] }); return; }
    setLoading(true);
    const endpoint = feedUrl
      ? `/api/feed-by-url?url=${encodeURIComponent(feedUrl)}`
      : `/api/feed?id=${feedId}`;
    fetch(endpoint)
      .then((r) => r.json())
      .then((d) => setData({ podcast: d.podcast, episodes: d.episodes }))
      .finally(() => setLoading(false));
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [feedId, feedUrl]);

  if (!feedId && !feedUrl) {
    return (
      <div ref={containerRef} className="text-muted text-sm py-12 text-center px-4 border border-dashed border-bone/15">
        select a podcast on the left to see episodes
      </div>
    );
  }
  if (loading) return <div ref={containerRef} className="text-muted text-sm py-8">loading episodes…</div>;
  if (!data.podcast) return <div ref={containerRef} className="text-muted text-sm py-8">not found</div>;

  const showHasValue = !!data.podcast.value && data.podcast.value.recipients?.length > 0;

  return (
    <div ref={containerRef}>
      <header className="flex flex-wrap items-start gap-4 pb-4 border-b border-bone/15">
        {data.podcast.image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={data.podcast.image} alt="" className="w-20 h-20 object-cover border border-bone/20 flex-shrink-0" />
        )}
        <div className="min-w-0 flex-1 basis-40">
          <h2 className="font-display text-2xl leading-tight break-words">{data.podcast.title}</h2>
          <p className="text-xs text-muted mt-1">{data.podcast.author}</p>
          {data.podcast.value && (
            <button
              type="button"
              onClick={() => setValueOpen((v) => !v)}
              className="stamp mt-2 text-bolt border-bolt/60 hover:bg-bolt/10 transition cursor-pointer"
              aria-expanded={valueOpen}
              title={valueOpen ? 'Hide split details' : 'Show split details'}
            >
              ⚡ {data.podcast.value.recipients.length} recipients · {data.podcast.value.method}
              <span className="ml-1">{valueOpen ? '▾' : '▸'}</span>
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
          <FavHeart podcast={data.podcast} />
          {showHasValue && (
            <button
              onClick={() => setShowBoostOpen(true)}
              className="btn-bolt"
              title="Boost the show"
            >
              <BoltIcon /> BOOST
            </button>
          )}
        </div>
      </header>
      {valueOpen && data.podcast.value && (
        <ValueBlockDetails value={data.podcast.value} />
      )}
      <ul className="divide-y divide-bone/10 max-h-[60vh] overflow-y-auto">
        {data.episodes.map((e) => {
          const playing = current?.episode.id === e.id;
          return (
            <li
              key={e.id}
              className={`flex gap-3 py-3 cursor-pointer group transition ${
                playing ? 'bg-bolt/10' : 'hover:bg-bone/5'
              }`}
              onClick={() => data.podcast && play(e, data.podcast)}
            >
              <button className="w-9 h-9 flex-shrink-0 border border-bone/40 group-hover:border-bolt grid place-items-center text-bone group-hover:text-bolt">
                {playing ? '❚❚' : '▶'}
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-display leading-tight truncate">{e.title}</div>
                <div className="text-[11px] text-muted flex gap-2 mt-0.5">
                  {e.datePublished && <span>{new Date(e.datePublished * 1000).toLocaleDateString()}</span>}
                  {e.duration && <span>· {Math.round(e.duration / 60)}m</span>}
                  {e.value && <span className="text-bolt">· ⚡ V4V</span>}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {data.podcast.podcastGuid && (
        <PodcastNostrFeed
          podcastGuid={data.podcast.podcastGuid}
          podcastTitle={data.podcast.title}
        />
      )}

      {showBoostOpen && data.podcast && showHasValue && (
        <BoostModal
          podcast={data.podcast}
          onClose={() => setShowBoostOpen(false)}
        />
      )}
    </div>
  );
}
