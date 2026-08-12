'use client';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Episode, Podcast, ValueBlock } from '@/lib/types';
import { useApp } from '@/lib/store';
import { fmtDuration, fmtLiveTime } from '@/lib/format';
import { hasValueRecipients, isMusicMedium } from '@/lib/util';
import { resolveEpisodeByFeedUrl, resolvePodcastByFeedUrl, resolvePodcastByGuid } from '@/lib/podcast-meta';
import { BoostModal } from './boost-modal';
import { BoltIcon, ShareIcon, CoinIcon } from './icons';
import { PodcastCover } from './podcast-cover';
import { PodcastNostrFeed } from './podcast-nostr-feed';
import { DeferredOnScroll } from './deferred-on-scroll';
import { Podroll } from './podroll';
import { FavEpisodeHeart, FavHeart } from './fav-heart';
import { ValueSplitRows } from './value-split-rows';
import { useStreamPanel } from './streaming-settings';
import { applyLiveStatuses } from '@/lib/live-status';
import { useLiveStatusPoll } from '@/lib/use-live-status-poll';

// Re-exported for the surfaces that have always imported it from here.
export { FavEpisodeHeart, FavHeart };

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
      className="btn-ghost"
      title={funding.message || 'Support this show'}
    >
      <CoinIcon /> SUPPORT
    </a>
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
          {podcast.isPreview && (
            <span className="stamp text-muted border-muted/40">NOT IN PI</span>
          )}
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

/**
 * Favorited episodes. Selecting one opens its parent SHOW rather than playing
 * inline: a FavoriteEpisode is a display cache, not an Episode — it carries no
 * value block, chapters or transcript — so fabricating one to hand to the
 * player would push a half-formed object into the boost modal and the
 * streaming engine. The show page resolves the real episode for free.
 */
export function FavoriteEpisodesList({ onSelect }: { onSelect: (p: Podcast) => void }) {
  const favoriteEpisodes = useApp((s) => s.favoriteEpisodes);
  const list = useMemo(
    () => Object.values(favoriteEpisodes).sort((a, b) => b.addedAt - a.addedAt),
    [favoriteEpisodes],
  );

  // Fill in the entries Podcast Index couldn't describe, from their own feeds.
  //
  // This runs HERE rather than in the hydrator on purpose: each one costs a
  // feed fetch and parse, and a real 227-track list spans 159 distinct feeds,
  // so doing it at sign-in would be a fetch storm. Rendering the list is the
  // first moment the metadata is actually needed. Results are cached per
  // episode (`storage.episodeMeta`), so this is a one-time cost per device.
  //
  // Sequential, not Promise.all: 159 parallel fetches to small self-hosted
  // feed hosts is a burst those servers should not have to absorb, and there
  // is no deadline here — rows fill in as they arrive.
  const pendingKey = useMemo(
    () => list.filter((ep) => ep.unresolved && ep.feedUrl).map((ep) => ep.itemGuid).join(','),
    [list],
  );
  useEffect(() => {
    if (!pendingKey) return;
    let cancelled = false;
    (async () => {
      for (const itemGuid of pendingKey.split(',')) {
        if (cancelled) return;
        const entry = useApp.getState().favoriteEpisodes[itemGuid];
        // Re-read from the store each iteration: an earlier pass (or another
        // mount of this list) may already have resolved it.
        if (!entry?.unresolved || !entry.feedUrl) continue;
        const episode = await resolveEpisodeByFeedUrl(entry.feedUrl, itemGuid);
        if (cancelled || !episode) continue;
        const { favoriteEpisodes: current, setFavoriteEpisodes } = useApp.getState();
        const prev = current[itemGuid];
        if (!prev) continue; // unfavorited while we were fetching
        setFavoriteEpisodes({
          ...current,
          [itemGuid]: {
            ...prev,
            feedId: episode.feedId,
            feedGuid: episode.podcastGuid || prev.feedGuid,
            title: episode.title,
            podcastTitle: episode.feedTitle,
            image: episode.image || episode.feedImage,
            enclosureUrl: episode.enclosureUrl,
            datePublished: episode.datePublished,
            // Keep the ORIGINAL addedAt: this is a backfill, not a new
            // favorite, and stamping now would bubble it to the top of the list.
            addedAt: prev.addedAt,
            unresolved: false,
          },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingKey]);

  if (!list.length) return null;

  return (
    <>
      <div className="text-[11px] uppercase tracking-widest text-muted mt-4 mb-2 px-1">
        {list.length} favorite {list.length === 1 ? 'episode' : 'episodes'}
      </div>
      <ul className="divide-y divide-bone/10">
        {list.map((ep) => (
          <li
            key={ep.itemGuid}
            className="flex gap-3 py-3 px-1 cursor-pointer group transition hover:bg-bone/5"
            onClick={async () => {
              // feedId is present for anything this device resolved through PI.
              // An entry synced from another app before its backfill ran has
              // only the guid, so fall back to resolving it on demand.
              if (ep.feedId) {
                onSelect({
                  id: ep.feedId,
                  podcastGuid: ep.feedGuid,
                  title: ep.podcastTitle ?? ep.title,
                  image: ep.image,
                  url: ep.feedUrl,
                });
                return;
              }
              // A placeholder from a feed PI doesn't index has no usable
              // feedGuid — the URL hint is the only handle on its show.
              const podcast = ep.feedGuid
                ? await resolvePodcastByGuid(ep.feedGuid)
                : ep.feedUrl
                  ? await resolvePodcastByFeedUrl(ep.feedUrl)
                  : null;
              if (podcast) onSelect(podcast);
            }}
          >
            <PodcastCover
              image={ep.image}
              title={ep.title}
              seed={ep.itemGuid}
              className="w-14 h-14 border border-bone/20 flex-shrink-0 text-xl"
            />
            <div className="min-w-0 flex-1">
              <div className="font-display text-base leading-tight truncate">
                {/* An unresolved entry is a real favorite whose metadata hasn't
                    arrived yet — never render it as an empty row. */}
                {ep.title || (ep.unresolved ? <span className="text-muted">Loading…</span> : '')}
              </div>
              <div className="text-xs text-muted truncate">{ep.podcastTitle}</div>
            </div>
          </li>
        ))}
      </ul>
    </>
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

export function EpisodeList({ feedId, feedUrl }: { feedId: number | null; feedUrl?: string }) {
  const [data, setData] = useState<{ podcast: Podcast | null; episodes: Episode[] }>({
    podcast: null, episodes: [],
  });
  const [loading, setLoading] = useState(false);
  const [showBoostOpen, setShowBoostOpen] = useState(false);
  const [boostTrack, setBoostTrack] = useState<Episode | null>(null);
  const [valueOpen, setValueOpen] = useState(false);
  // Episodes are revealed 10 at a time behind a "Load more" button. The Nostr
  // comments feed sits below this list, so a button (not infinite scroll) keeps
  // it at a stable, reachable position on mobile.
  const [visibleCount, setVisibleCount] = useState(10);
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
    liveMissesRef.current = {};
    if (!feedId) { setData({ podcast: null, episodes: [] }); return; }
    setLoading(true);
    // Preview (not-in-PI) feeds load by URL — the synthetic id can't be
    // resolved server-side. PI feeds load by numeric id as before.
    const endpoint = feedUrl
      ? `/api/feed?url=${encodeURIComponent(feedUrl)}`
      : `/api/feed?id=${feedId}`;
    fetch(endpoint)
      .then((r) => r.json())
      .then((d) => {
        setData({ podcast: d.podcast, episodes: d.episodes });
        setEpisodeQueue(d.episodes);
        // Push the RSS-enriched podcast (funding/medium/podroll) back into the
        // store so the episode detail view — which reads selectedPodcast — shows
        // the SUPPORT link the show page gets. No-op if it's a different show.
        if (d.podcast) syncSelectedPodcast(d.podcast);
      })
      .finally(() => setLoading(false));
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [feedId, feedUrl, setEpisodeQueue, syncSelectedPodcast]);

  // Above the early returns — hook order has to stay stable, and the hook
  // itself no-ops (returns nulls) while the podcast is still null.
  const { button: streamButton, panel: streamPanel } = useStreamPanel(
    data.podcast,
    hasValueRecipients(data.podcast?.value),
  );

  // A live item's status is fixed at load time otherwise: /api/feed is fetched
  // once per feedId and nothing asks again. Polls only while this feed has a
  // live item on screen, and patches liveStatus/liveStartTime in place —
  // setEpisodeQueue and syncSelectedPodcast are deliberately NOT re-fired, so
  // playback is undisturbed.
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

  const showHasValue = hasValueRecipients(data.podcast.value);
  const isMusic = isMusicMedium(data.podcast);
  // First non-pending track — for music feeds episodes are sorted track-order ascending.
  const firstPlayable = data.episodes.find((e) => e.liveStatus !== 'pending') ?? data.episodes[0];
  // Is the currently-playing track part of this show?
  const showIsCurrent = !!current && (
    (!!data.podcast.podcastGuid && current.podcast.podcastGuid === data.podcast.podcastGuid) ||
    current.podcast.id === data.podcast.id
  );
  // Music feeds show the whole album (track order); other shows paginate 10 at a time.
  const visibleEpisodes = isMusic ? data.episodes : data.episodes.slice(0, visibleCount);
  const remaining = data.episodes.length - visibleEpisodes.length;

  return (
    <div ref={containerRef}>
      <header className="sticky top-[var(--app-header-h)] z-10 bg-ink/90 backdrop-blur -mx-4 px-4 flex items-start gap-4 pb-4 border-b border-bone/15">
        {isMusic && firstPlayable ? (
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
          <h2 className="font-display text-3xl leading-tight font-semibold break-words">{data.podcast.title}</h2>
          <p className="text-sm text-muted mt-1">{data.podcast.author}</p>
          {data.podcast.isPreview && (
            <span
              className="stamp mt-2 text-muted border-muted/40"
              title="This feed isn't in Podcast Index — parsed directly from RSS for preview"
            >
              NOT IN PI · PREVIEW
            </span>
          )}
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
            <SupportButton podcast={data.podcast} />
            {streamButton}
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
      {streamPanel && (
        <div className="px-4 sm:px-6 pb-4 border-b border-bone/10">{streamPanel}</div>
      )}
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
              onClick={() => {
                // Tracks carry little extra metadata, so a row tap just plays
                // the track rather than opening the episode detail view.
                if (isMusic) {
                  if (e.liveStatus !== 'pending' && data.podcast) play(e, data.podcast);
                } else {
                  openEpisode(e);
                }
              }}
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
              {hasValueRecipients(e.value) && (
                <button
                  type="button"
                  onClick={(ev) => { ev.stopPropagation(); setBoostTrack(e); }}
                  className="btn-bolt self-center flex-shrink-0"
                  title="Boost this track"
                >
                  <BoltIcon /> BOOST
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
          onClick={() => setVisibleCount((c) => Math.min(c + 10, data.episodes.length))}
          className="btn-ghost w-full mt-3"
        >
          Load more episodes ({remaining})
        </button>
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
