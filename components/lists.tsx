'use client';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Episode, Podcast, FavoritePodcast, ValueBlock } from '@/lib/types';
import { useApp } from '@/lib/store';
import { resolvePublishRelays, schedulePublishFavorites } from '@/lib/nostr';
import { fmtDuration } from '@/lib/format';
import { BoostModal } from './boost-modal';
import { BoltIcon, ShareIcon } from './icons';
import { PodcastCover } from './podcast-cover';
import { PodcastNostrFeed } from './podcast-nostr-feed';
import { DeferredOnScroll } from './deferred-on-scroll';


function fmtLiveTime(unixSec: number) {
  const d = new Date(unixSec * 1000);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function LiveBadge({ status }: { status: NonNullable<Episode['liveStatus']> }) {
  if (status === 'live') {
    return (
      <span className="stamp text-nostr border-nostr/60 bg-nostr/10 animate-bolt">● LIVE</span>
    );
  }
  if (status === 'pending') {
    return <span className="stamp text-bolt border-bolt/60">PENDING</span>;
  }
  return null;
}

function FavHeart({ podcast, size = 'sm' }: { podcast: Podcast; size?: 'sm' | 'md' }) {
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
        artwork: podcast.artwork,
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
      className={`inline-flex items-center justify-center font-mono uppercase tracking-wider border transition active:translate-y-px flex-shrink-0 ${
        size === 'md'
          ? 'gap-2 px-4 py-2 text-sm'
          : 'gap-1.5 px-3 text-xs leading-none'
      } ${
        isFav
          ? 'border-nostr text-nostr hover:bg-nostr/10'
          : 'border-bone/40 text-bone/70 hover:border-nostr/70 hover:text-nostr'
      }`}
    >
      <span className={size === 'md' ? 'text-lg leading-none' : 'text-base leading-none'}>
        {isFav ? '♥' : '♡'}
      </span>
      {isFav ? 'FAVORITED' : 'FAVORITE'}
    </button>
  );
}

function ShareButton({ podcast }: { podcast: Podcast }) {
  const [copied, setCopied] = useState(false);
  const guid = podcast.podcastGuid;
  if (!guid) return null;

  async function onClick() {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set('podcast', guid!);
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — silent no-op */
    }
  }

  return (
    <button
      onClick={onClick}
      className="btn-ghost"
      title="Copy link to this show"
      aria-label="Copy link to this show"
    >
      <ShareIcon /> {copied ? 'COPIED' : 'SHARE'}
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
      <PodcastCover
        image={podcast.image}
        artwork={podcast.artwork}
        title={podcast.title}
        seed={podcast.podcastGuid ?? String(podcast.id)}
        className="w-14 h-14 border border-bone/20 flex-shrink-0 text-xl"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-display text-base leading-tight truncate">{podcast.title}</span>
          {podcast.medium === 'publisher' && (
            <span className="stamp text-muted border-muted/40">▸ ALBUMS</span>
          )}
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
      Object.values(favorites).sort((a, b) =>
        (a.title ?? '').localeCompare(b.title ?? '', undefined, { sensitivity: 'base' }),
      ),
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
          artwork: p.artwork,
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

export function EpisodeList({ feedId }: { feedId: number | null }) {
  const [data, setData] = useState<{ podcast: Podcast | null; episodes: Episode[] }>({
    podcast: null, episodes: [],
  });
  const [loading, setLoading] = useState(false);
  const [showBoostOpen, setShowBoostOpen] = useState(false);
  const [valueOpen, setValueOpen] = useState(false);
  // Episodes are revealed 10 at a time behind a "Load more" button. The Nostr
  // comments feed sits below this list, so a button (not infinite scroll) keeps
  // it at a stable, reachable position on mobile.
  const [visibleCount, setVisibleCount] = useState(10);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const play = useApp((s) => s.play);
  const current = useApp((s) => s.current);
  const openEpisode = useApp((s) => s.openEpisode);
  const setEpisodeQueue = useApp((s) => s.setEpisodeQueue);

  useEffect(() => {
    setValueOpen(false);
    setVisibleCount(10);
    if (!feedId) { setData({ podcast: null, episodes: [] }); return; }
    setLoading(true);
    fetch(`/api/feed?id=${feedId}`)
      .then((r) => r.json())
      .then((d) => { setData({ podcast: d.podcast, episodes: d.episodes }); setEpisodeQueue(d.episodes); })
      .finally(() => setLoading(false));
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [feedId]);

  if (!feedId) {
    return (
      <div ref={containerRef} className="text-muted text-sm py-12 text-center px-4 border border-dashed border-bone/15">
        <span className="lg:hidden">select a podcast above to see episodes</span>
        <span className="hidden lg:inline">select a podcast on the left to see episodes</span>
      </div>
    );
  }
  if (loading) return <div ref={containerRef} className="text-muted text-sm py-8">loading episodes…</div>;
  if (!data.podcast) return <div ref={containerRef} className="text-muted text-sm py-8">not found</div>;

  const showHasValue = !!data.podcast.value && data.podcast.value.recipients?.length > 0;
  const visibleEpisodes = data.episodes.slice(0, visibleCount);
  const remaining = data.episodes.length - visibleEpisodes.length;

  return (
    <div ref={containerRef}>
      <header className="sticky top-[var(--app-header-h)] z-10 bg-ink/90 backdrop-blur -mx-4 px-4 flex items-start gap-4 pb-4 border-b border-bone/15">
        <PodcastCover
          image={data.podcast.image}
          artwork={data.podcast.artwork}
          title={data.podcast.title}
          seed={data.podcast.podcastGuid ?? String(data.podcast.id)}
          className="w-20 h-20 border border-bone/20 flex-shrink-0 text-3xl"
        />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-3xl leading-tight font-semibold break-words">{data.podcast.title}</h2>
          <p className="text-sm text-muted mt-1">{data.podcast.author}</p>
          {data.podcast.value && (
            <button
              type="button"
              onClick={() => setValueOpen((v) => !v)}
              className="stamp mt-2 text-bolt border-bolt/60 hover:bg-bolt/10 transition cursor-pointer"
              aria-expanded={valueOpen}
              title={valueOpen ? 'Hide split details' : 'Show split details'}
            >
              ⚡ {data.podcast.value.recipients?.length ?? 0} recipients
              <span className="ml-1">{valueOpen ? '▾' : '▸'}</span>
            </button>
          )}
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <FavHeart podcast={data.podcast} size="md" />
            <ShareButton podcast={data.podcast} />
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
        </div>
      </header>
      {valueOpen && data.podcast.value && (
        <ValueBlockDetails value={data.podcast.value} />
      )}
      <ul className="divide-y divide-bone/10">
        {visibleEpisodes.map((e, idx) => {
          const playing = current?.episode.id === e.id;
          const prev = idx > 0 ? visibleEpisodes[idx - 1] : null;
          const isFirstLive = !!e.liveStatus && (!prev || !prev.liveStatus);
          const isFirstRegular = !e.liveStatus && !!prev?.liveStatus;
          return (
            <Fragment key={e.id}>
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
              onClick={() => openEpisode(e)}
            >
              <div className="flex gap-3 py-3 pr-3">
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (e.liveStatus === 'pending') return;
                  if (data.podcast) play(e, data.podcast);
                }}
                disabled={e.liveStatus === 'pending'}
                className="relative w-12 h-12 flex-shrink-0 disabled:cursor-not-allowed"
                title={e.liveStatus === 'pending' ? 'Not started yet' : playing ? 'Now playing' : 'Play'}
                aria-label={playing ? 'Now playing' : 'Play'}
              >
                <PodcastCover
                  image={e.image}
                  artwork={e.feedImage || data.podcast?.artwork}
                  title={e.title}
                  seed={e.guid ?? String(e.id)}
                  className="w-full h-full border border-bone/40 group-hover:border-bolt text-base"
                />
                {e.liveStatus !== 'pending' && (
                  <div
                    className={`absolute inset-0 grid place-items-center bg-ink/55 transition pointer-events-none ${
                      playing
                        ? 'opacity-100 text-bolt'
                        : 'opacity-0 group-hover:opacity-100 text-bone group-hover:text-bolt'
                    }`}
                  >
                    {playing ? '❚❚' : '▶'}
                  </div>
                )}
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {e.liveStatus && <LiveBadge status={e.liveStatus} />}
                  <div className="text-base font-display font-medium leading-tight truncate">{e.title}</div>
                </div>
                <div className="text-xs text-muted flex gap-2 mt-0.5">
                  {e.liveStatus && e.liveStartTime ? (
                    <span>
                      {e.liveStatus === 'pending' ? 'starts ' : 'started '}
                      {fmtLiveTime(e.liveStartTime)}
                    </span>
                  ) : (
                    e.datePublished && <span>{new Date(e.datePublished * 1000).toLocaleDateString()}</span>
                  )}
                  {e.duration && <span>· {fmtDuration(e.duration)}</span>}
                  {e.value && <span className="text-bolt">· ⚡ V4V</span>}
                </div>
                {e.socialInteract?.length ? (
                  <span className="text-nostr text-[11px] mt-0.5">💬 discussion</span>
                ) : null}
                {e.valueTimeSplits?.length ? (
                  <span className="text-bolt text-[11px] mt-0.5">⚡ {e.valueTimeSplits.length} tracks</span>
                ) : null}
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
          onClick={() => setVisibleCount((c) => Math.min(c + 10, data.episodes.length))}
          className="btn-ghost w-full mt-3"
        >
          Load more episodes ({remaining})
        </button>
      )}

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
          />
        </DeferredOnScroll>
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
