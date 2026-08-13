'use client';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Episode, Podcast, ValueBlock } from '@/lib/types';
import { useApp } from '@/lib/store';
import { fmtDuration, fmtLiveTime } from '@/lib/format';
import { hasValueRecipients, isMusicMedium } from '@/lib/util';
import { resolvePodcastByGuid } from '@/lib/podcast-meta';
import { BoostModal } from './boost-modal';
import { BoltIcon, ShareIcon, CoinIcon } from './icons';
import { PodcastCover } from './podcast-cover';
import { PodcastNostrFeed } from './podcast-nostr-feed';
import { DeferredOnScroll } from './deferred-on-scroll';
import { Podroll } from './podroll';
import { FavEpisodeHeart, FavEpisodeRowHeart, FavHeart } from './fav-heart';
import { ValueSplitRows } from './value-split-rows';
import { useStreamPanel } from './streaming-settings';
import { applyLiveStatuses } from '@/lib/live-status';
import { useLiveStatusPoll } from '@/lib/use-live-status-poll';

// Re-exported for the surfaces that have always imported it from here.
export { FavEpisodeHeart, FavEpisodeRowHeart, FavHeart };

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

/**
 * Group order for the favorites lists. Anything not named here sorts
 * alphabetically after these, and **medium-unknown is last and is its own
 * bucket** — never folded into `podcast`.
 *
 * That last part is the whole point of the position-4 hint. The list carries
 * podcasts and music at once by design, so whichever way you default you are
 * wrong about half of it, and an entry with no medium is one nobody has told us
 * about — which is not the same claim as "it's a podcast".
 */
const MEDIUM_ORDER = ['music', 'podcast', 'audiobook', 'film', 'video', 'newsletter', 'blog', 'publisher'];

/**
 * Split rows into medium buckets, in {@link MEDIUM_ORDER}, unknown last.
 *
 * Case is folded for BUCKETING only. The wire value is never normalized — the
 * medium vocabulary is open, so a value we don't recognize is one a newer app
 * does, and it gets its own bucket under its own label rather than being
 * dropped or coerced.
 */
function groupByMedium<T>(rows: T[], mediumOf: (row: T) => string | undefined) {
  const buckets = new Map<string, { label: string; rows: T[] }>();
  const unknown: T[] = [];
  for (const row of rows) {
    const raw = mediumOf(row);
    if (!raw) { unknown.push(row); continue; }
    const key = raw.toLowerCase();
    const bucket = buckets.get(key) ?? { label: raw, rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }
  const rank = (key: string) => {
    const i = MEDIUM_ORDER.indexOf(key);
    return i === -1 ? MEDIUM_ORDER.length : i;
  };
  const groups = [...buckets.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([key, b]) => ({ key, label: b.label, rows: b.rows }));
  if (unknown.length) groups.push({ key: '~unknown', label: 'medium unknown', rows: unknown });
  return groups;
}

/**
 * What one row of a favorited feed is called, by medium.
 *
 * A music feed's items are singles, not episodes — calling a track an episode
 * is wrong in the one place the user is most likely to be looking, since music
 * is the bulk of this list. Anything else keeps "episode": the alternatives
 * (chapters for an audiobook, and so on) are guesses about an open vocabulary,
 * and a wrong specific word reads worse than a right generic one.
 */
function itemNoun(mediumKey: string, n: number): string {
  const one = mediumKey === 'music' ? 'single' : 'episode';
  return n === 1 ? one : `${one}s`;
}

/** A group heading, shown only when there is more than one group — a lone
 *  "PODCAST" banner over an undivided list is noise, not information. */
function MediumHeading({ label }: { label: string }) {
  return (
    <div className="text-[11px] uppercase tracking-widest text-muted mt-3 mb-1 px-1">{label}</div>
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
      Object.values(favorites).sort((a, b) => {
        // Unresolved entries have no title. Sink them rather than letting an
        // empty string sort them to the top of the user's library.
        if (!a.title !== !b.title) return a.title ? -1 : 1;
        return (a.title ?? '').localeCompare(b.title ?? '', undefined, { sensitivity: 'base' });
      }),
    [favorites],
  );

  const groups = useMemo(() => groupByMedium(list, (p) => p.medium), [list]);

  if (!list.length) return null;

  return (
    <>
      {groups.map((g) => (
        <div key={g.key}>
          {groups.length > 1 && <MediumHeading label={g.label} />}
          <ul className="divide-y divide-bone/10">
            {g.rows.map((p) => {
              const title = p.title;
              // No title means Podcast Index hasn't answered for this guid — a
              // feed that was never indexed, or has since been delisted. Render
              // it rather than hiding it: it is still the user's favorite and is
              // still republished, and a row they can see is one they can clean
              // up.
              if (!title) {
                return <UnresolvedFavoriteRow key={p.podcastGuid} id={p.podcastGuid} kind="show" />;
              }
              // FavoritePodcast → Podcast: the cache doesn't carry the value
              // block, so the value-aware stamp is hidden via showV4VStamp.
              const minimal: Podcast = {
                id: p.id,
                podcastGuid: p.podcastGuid,
                title,
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
        </div>
      ))}
    </>
  );
}

/**
 * A favorite whose identifier this device can't resolve.
 *
 * It exists because the favorite is the guid, not the metadata: an entry
 * Podcast Index doesn't know is not an entry we may drop, so it has to have
 * somewhere to go on screen. Deliberately inert — there is nothing to open.
 */
function UnresolvedFavoriteRow({ id, kind }: { id: string; kind: 'show' | 'episode' }) {
  return (
    <li className="flex gap-3 py-3 px-1 items-center">
      <div className="w-14 h-14 border border-bone/20 flex-shrink-0 grid place-items-center text-muted text-xl">
        ?
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-display text-base leading-tight text-muted">
          Couldn&apos;t load this {kind}
        </div>
        <div className="text-[11px] font-mono text-muted/70 truncate">{id}</div>
      </div>
    </li>
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
  // Item favorites another app added are ordinary rows now. They used to need a
  // separate store slot: on the two-address design, copying an item entry found
  // on the FEEDS list over to the ITEMS list made it removable from one and not
  // the other, so unfavoriting it brought it back on every load, forever. One
  // event means no relocation, so the hazard is gone and the quarantine with
  // it — what keeps another app's entries safe now is the baseline, per entry.
  const list = useMemo(
    () => Object.values(favoriteEpisodes).sort((a, b) => b.addedAt - a.addedAt),
    [favoriteEpisodes],
  );

  const groups = useMemo(() => groupByMedium(list, (ep) => ep.medium), [list]);

  if (!list.length) return null;

  return (
    <>
      {groups.map((g) => (
        <div key={g.key}>
          {/* Counted PER MEDIUM so each group can use its own noun — a track on
              a music feed is a single, not an episode. One combined heading
              would have to pick one word and be wrong for half the list, the
              same trap `MEDIUM_ORDER` exists to avoid. The overall total is on
              the panel header. */}
          <div className="text-[11px] uppercase tracking-widest text-muted mt-4 mb-2 px-1">
            {groups.length > 1 && `${g.label} — `}
            {g.rows.length} favorite {itemNoun(g.key, g.rows.length)}
          </div>
          <ul className="divide-y divide-bone/10">
            {g.rows.map((ep) => {
              const { title, feedGuid } = ep;
              // Unresolved: no parent feed guid to look up, or PI had nothing for
              // it. Still the user's favorite, still republished — see
              // <UnresolvedFavoriteRow>.
              if (!title) return <UnresolvedFavoriteRow key={ep.itemGuid} id={ep.itemGuid} kind="episode" />;
              return (
                <li
                  key={ep.itemGuid}
                  className="flex gap-3 py-3 px-1 cursor-pointer group transition hover:bg-bone/5"
                  onClick={async () => {
                    // feedId is present for anything this device resolved through
                    // PI. An entry synced from another app before its backfill ran
                    // has only the guid, so fall back to resolving it on demand.
                    if (!feedGuid) return;
                    if (ep.feedId) {
                      onSelect({
                        id: ep.feedId,
                        podcastGuid: feedGuid,
                        title: ep.podcastTitle ?? title,
                        image: ep.image,
                        url: ep.feedUrl,
                      });
                      return;
                    }
                    const podcast = await resolvePodcastByGuid(feedGuid);
                    if (podcast) onSelect(podcast);
                  }}
                >
                  <PodcastCover
                    image={ep.image}
                    title={title}
                    seed={ep.itemGuid}
                    className="w-14 h-14 border border-bone/20 flex-shrink-0 text-xl"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-display text-base leading-tight truncate">{title}</div>
                    {/* Only when it says something the title didn't. A single
                        names its album after its one track, so printing both
                        renders the same words twice and reads as an album
                        sitting in the episodes list — 74 of one user's 227
                        tracks. */}
                    {ep.podcastTitle && ep.podcastTitle !== title && (
                      <div className="text-xs text-muted truncate">{ep.podcastTitle}</div>
                    )}
                  </div>
                  <div className="flex-shrink-0 self-center">
                    <FavEpisodeRowHeart favorite={ep} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
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
