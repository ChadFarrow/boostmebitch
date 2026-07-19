'use client';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Episode, FavoritePodcast, Podcast, ValueBlock } from '@/lib/types';
import { useApp, epKey } from '@/lib/store';
import { fmtDuration, fmtLiveTime } from '@/lib/format';
import { hasValueRecipients, isMusicMedium } from '@/lib/util';
import { BoostModal } from './boost-modal';
import { BoltIcon, ShareIcon, CoinIcon } from './icons';
import { PodcastCover } from './podcast-cover';
import { PodcastNostrFeed } from './podcast-nostr-feed';
import { DeferredOnScroll } from './deferred-on-scroll';
import { Podroll } from './podroll';
import { FavHeart } from './fav-heart';

// Re-exported for the surfaces that have always imported it from here.
export { FavHeart };

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
  newCount = 0,
  expanded = false,
  onToggleExpand,
  favSize = 'sm',
  children,
}: {
  podcast: Podcast;
  selected: boolean;
  onSelect: (p: Podcast) => void;
  showV4VStamp: boolean;
  // Inbox: count of unseen new episodes for this show, plus an expandable
  // sublist rendered as `children`. Absent/0 keeps the plain search-result row.
  newCount?: number;
  expanded?: boolean;
  onToggleExpand?: () => void;
  // Inbox rows pass 'icon' — every row is already a favorite there, so a bare
  // heart declutters vs. the full FAVORITED button used in search results.
  favSize?: 'sm' | 'md' | 'icon';
  children?: ReactNode;
}) {
  return (
    <li className="py-3 px-1">
      <div
        onClick={() => onSelect(podcast)}
        className={`flex gap-3 cursor-pointer group transition ${
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
        {newCount > 0 && onToggleExpand ? (
          // The badge IS the disclosure control — click to reveal the show's new
          // episodes. Placed by the FAVORITE button so the revealed episodes'
          // + queue / play actions sit right under where you tapped. A chevron
          // (not a play triangle) signals expand.
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide new episodes' : 'Show new episodes'}
            className="stamp text-bolt border-bolt/60 hover:bg-bolt/10 transition self-center flex-shrink-0"
          >
            {newCount} NEW <span aria-hidden>{expanded ? '⌃' : '⌄'}</span>
          </button>
        ) : newCount > 0 ? (
          <span className="stamp text-bolt border-bolt/60 self-center flex-shrink-0">{newCount} NEW</span>
        ) : null}
        <FavHeart podcast={podcast} size={favSize} />
      </div>
      {expanded && children ? (
        <div onClick={(e) => e.stopPropagation()}>{children}</div>
      ) : null}
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

// New-episode window: an episode counts as "new" in the inbox if it's within
// 30 days and unseen. We deliberately do NOT gate on the favorite's addedAt —
// for Nostr-synced favorites addedAt is "when this device first resolved the
// show" (favorites-hydrator sets Date.now()), not when the user favorited, so
// it would wrongly suppress every already-published episode. The 30-day window
// + the seen set bound the volume instead. datePublished is unix SECONDS.
const NEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Fetch recent episodes across all favorited feeds in one call. Mount + when
// the favorites id-set changes + manual refresh only — never on a timer
// (mirrors the EpisodeList fetch convention). Groups the flat response by feed.
function useInboxNew(favoriteIds: number[]) {
  const idsKey = useMemo(
    () => [...favoriteIds].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b).join(','),
    [favoriteIds],
  );
  const [byFeed, setByFeed] = useState<Record<number, Episode[]>>({});
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((n) => n + 1);

  useEffect(() => {
    if (!idsKey) { setByFeed({}); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/new-episodes?ids=${idsKey}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const grouped: Record<number, Episode[]> = {};
        for (const e of (d.episodes ?? []) as Episode[]) {
          (grouped[e.feedId] ??= []).push(e);
        }
        setByFeed(grouped);
      })
      .catch(() => { if (!cancelled) setByFeed({}); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [idsKey, tick]);

  return { byFeed, refresh, loading };
}

// FavoritePodcast → minimal Podcast (the favorites cache carries no value block).
function favToPodcast(p: FavoritePodcast): Podcast {
  return {
    id: p.id,
    podcastGuid: p.podcastGuid,
    title: p.title,
    author: p.author,
    image: p.image,
    artwork: p.artwork,
    url: p.url,
  };
}

// The new episodes for one favorited show: unseen, guid-bearing, within window.
function newEpisodesFor(eps: Episode[] | undefined, seen: Set<string>): Episode[] {
  if (!eps?.length) return [];
  const floor = Date.now() - NEW_WINDOW_MS;
  return eps
    .filter((e) => !!e.guid && !seen.has(epKey(e)) && (e.datePublished ?? 0) * 1000 >= floor)
    .sort((a, b) => (b.datePublished ?? 0) - (a.datePublished ?? 0));
}

function InboxEpisodeRow({ episode, podcast }: { episode: Episode; podcast: Podcast }) {
  const play = useApp((s) => s.play);
  const enqueueEpisode = useApp((s) => s.enqueueEpisode);
  const markSeen = useApp((s) => s.markSeen);
  const date = episode.datePublished
    ? new Date(episode.datePublished * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : '';
  return (
    <div className="flex items-center gap-3 py-1.5 pl-16 pr-1">
      <div className="min-w-0 flex-1">
        <div className="text-sm leading-tight truncate">{episode.title}</div>
        <div className="text-[11px] text-muted">
          {date}
          {episode.duration ? ` · ${fmtDuration(episode.duration)}` : ''}
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button type="button" onClick={() => play(episode, podcast)} className="btn-ghost text-xs px-2" aria-label="Play" title="Play">
          ▶
        </button>
        <button
          type="button"
          onClick={() => enqueueEpisode(episode, podcast)}
          className="btn-ghost text-xs px-2"
          aria-label="Add to queue"
          title="Add to queue"
        >
          + queue
        </button>
        <button type="button" onClick={() => markSeen(episode)} className="btn-ghost text-xs px-2" aria-label="Mark seen" title="Mark seen">
          ✓
        </button>
      </div>
    </div>
  );
}

export function InboxList({
  selected,
  onSelect,
}: {
  selected: number | null;
  onSelect: (p: Podcast) => void;
}) {
  const favorites = useApp((s) => s.favorites);
  const seenGuids = useApp((s) => s.seenGuids);
  const favoriteIds = useMemo(() => Object.values(favorites).map((f) => f.id), [favorites]);
  const { byFeed, refresh, loading } = useInboxNew(favoriteIds);
  // Per-show expand override; undefined → default (auto-expand shows with new eps).
  const [expandedOverride, setExpandedOverride] = useState<Record<string, boolean>>({});

  const rows = useMemo(() => {
    const out = Object.values(favorites).map((f) => {
      const raw = byFeed[f.id];
      return {
        fav: f,
        newEps: newEpisodesFor(raw, seenGuids),
        // Stable sort key: the newest release date from the RAW list (NOT the
        // seen-filtered one). Marking an episode seen must not change a show's
        // position — otherwise marking the newest re-sorts the show out from
        // under you and it reads as "everything below got cleared."
        sortDate: raw?.length ? Math.max(...raw.map((e) => e.datePublished ?? 0)) : 0,
      };
    });
    // Shows with unseen new episodes float to the top (most recent release
    // first); the rest keep alphabetical order.
    out.sort((a, b) => {
      const an = a.newEps.length > 0 ? 1 : 0;
      const bn = b.newEps.length > 0 ? 1 : 0;
      if (an !== bn) return bn - an;
      if (an === 1) return b.sortDate - a.sortDate;
      return (a.fav.title ?? '').localeCompare(b.fav.title ?? '', undefined, { sensitivity: 'base' });
    });
    return out;
  }, [favorites, byFeed, seenGuids]);

  if (!rows.length) return null;

  return (
    <div>
      <div className="flex justify-end px-1 pb-1">
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="btn-ghost text-xs px-2 disabled:opacity-40"
          aria-label="Refresh new episodes"
        >
          {loading ? '…' : '⟳'} refresh
        </button>
      </div>
      <ul className="divide-y divide-bone/10">
        {rows.map(({ fav, newEps }) => {
          const minimal = favToPodcast(fav);
          // Collapsed by default — the "N NEW" badge signals there's content;
          // tap the caret to reveal the episodes. Keeps the list scannable.
          const expanded = expandedOverride[fav.podcastGuid] ?? false;
          return (
            <PodcastRow
              key={fav.podcastGuid}
              podcast={minimal}
              selected={selected === fav.id}
              onSelect={onSelect}
              showV4VStamp={false}
              newCount={newEps.length}
              favSize="icon"
              expanded={expanded}
              onToggleExpand={() =>
                setExpandedOverride((m) => ({ ...m, [fav.podcastGuid]: !expanded }))
              }
            >
              {newEps.map((e) => (
                <InboxEpisodeRow key={epKey(e)} episode={e} podcast={minimal} />
              ))}
            </PodcastRow>
          );
        })}
      </ul>
    </div>
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
  const [boostTrack, setBoostTrack] = useState<Episode | null>(null);
  const [valueOpen, setValueOpen] = useState(false);
  // Episodes are revealed 10 at a time behind a "Load more" button. The Nostr
  // comments feed sits below this list, so a button (not infinite scroll) keeps
  // it at a stable, reachable position on mobile.
  const [visibleCount, setVisibleCount] = useState(10);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const play = useApp((s) => s.play);
  const togglePlay = useApp((s) => s.togglePlay);
  const isPlaying = useApp((s) => s.isPlaying);
  const current = useApp((s) => s.current);
  const openEpisode = useApp((s) => s.openEpisode);
  const enqueueEpisode = useApp((s) => s.enqueueEpisode);
  const listenQueue = useApp((s) => s.listenQueue);
  const setEpisodeQueue = useApp((s) => s.setEpisodeQueue);
  const syncSelectedPodcast = useApp((s) => s.syncSelectedPodcast);
  const queuedKeys = useMemo(
    () => new Set(listenQueue.map((i) => epKey(i.episode))),
    [listenQueue],
  );

  useEffect(() => {
    setValueOpen(false);
    setVisibleCount(10);
    if (!feedId) { setData({ podcast: null, episodes: [] }); return; }
    setLoading(true);
    fetch(`/api/feed?id=${feedId}`)
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
  }, [feedId, setEpisodeQueue, syncSelectedPodcast]);

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
              {e.liveStatus !== 'pending' && (() => {
                const queued = queuedKeys.has(epKey(e));
                return (
                  <button
                    type="button"
                    disabled={queued}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      if (data.podcast) enqueueEpisode(e, data.podcast);
                    }}
                    className={`btn-ghost text-xs px-2 self-center flex-shrink-0 ${
                      queued ? 'text-bolt border-bolt/60 disabled:opacity-100' : ''
                    }`}
                    aria-label={queued ? 'In your queue' : 'Add to queue'}
                    title={queued ? 'Already in your queue' : 'Add to queue'}
                  >
                    {queued ? '✓ queued' : '+ queue'}
                  </button>
                );
              })()}
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
