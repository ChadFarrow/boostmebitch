'use client';
import { useEffect, useMemo, useState } from 'react';
import type { Episode, Podcast, FavoritePodcast } from '@/lib/types';
import { useApp } from '@/lib/store';
import { resolvePublishRelays, schedulePublishFavorites } from '@/lib/nostr';
import { BoostModal } from './boost-modal';
import { BoltIcon } from './icons';
import { PodcastNostrFeed } from './podcast-nostr';

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

export function EpisodeList({ feedId }: { feedId: number | null }) {
  const [data, setData] = useState<{ podcast: Podcast | null; episodes: Episode[] }>({
    podcast: null, episodes: [],
  });
  const [loading, setLoading] = useState(false);
  const [showBoostOpen, setShowBoostOpen] = useState(false);
  const play = useApp((s) => s.play);
  const current = useApp((s) => s.current);

  useEffect(() => {
    if (!feedId) { setData({ podcast: null, episodes: [] }); return; }
    setLoading(true);
    fetch(`/api/feed?id=${feedId}`)
      .then((r) => r.json())
      .then((d) => setData({ podcast: d.podcast, episodes: d.episodes }))
      .finally(() => setLoading(false));
  }, [feedId]);

  if (!feedId) {
    return (
      <div className="text-muted text-sm py-12 text-center px-4 border border-dashed border-bone/15">
        select a podcast on the left to see episodes
      </div>
    );
  }
  if (loading) return <div className="text-muted text-sm py-8">loading episodes…</div>;
  if (!data.podcast) return <div className="text-muted text-sm py-8">not found</div>;

  const showHasValue = !!data.podcast.value && data.podcast.value.recipients?.length > 0;

  return (
    <div>
      <header className="flex gap-4 pb-4 border-b border-bone/15 items-start">
        {data.podcast.image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={data.podcast.image} alt="" className="w-20 h-20 object-cover border border-bone/20 flex-shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-2xl leading-tight">{data.podcast.title}</h2>
          <p className="text-xs text-muted mt-1">{data.podcast.author}</p>
          {data.podcast.value && (
            <p className="stamp mt-2 text-bolt border-bolt/60">
              ⚡ {data.podcast.value.recipients.length} recipients · {data.podcast.value.method}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2 flex-shrink-0">
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
      <ul className="divide-y divide-bone/10">
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
        <PodcastNostrFeed podcastGuid={data.podcast.podcastGuid} />
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
