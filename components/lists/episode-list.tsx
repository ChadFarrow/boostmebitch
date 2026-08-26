'use client';

// The selected show's header (artwork, value block, SHARE / SUPPORT / BOOST)
// and its episode or track list.

// `shrink-0 whitespace-nowrap` on both branches: .stamp is inline-flex with
// neither, and this sits in a flex row beside a truncating title with no slack,
// so on a phone `● LIVE` wrapped to two lines and blew up the row height.
import { Fragment, useEffect, useRef, useState } from 'react';
import type { Episode, Podcast, ValueBlock } from '@/lib/types';
import { useApp } from '@/lib/store';
import { fmtDate, fmtDuration, fmtLiveTime } from '@/lib/format';
import { hasValueRecipients, isMusicMedium, showShareUrl } from '@/lib/util';
import { applyLiveStatuses } from '@/lib/live-status';
import { loadFeed } from '@/lib/podcast-meta';
import { useLiveStatusPoll } from '@/lib/use-live-status-poll';
import { BoostModal } from '../boost-modal';
import { BoltIcon, CoinIcon } from '../icons';
import { CopyLinkButton } from '../copy-link-button';
import { PodcastCover } from '../podcast-cover';
import { PodcastNostrFeed } from '../podcast-nostr-feed';
import { DeferredOnScroll } from '../deferred-on-scroll';
import { Podroll } from '../podroll';
import { FavEpisodeHeart, FavHeart } from '../fav-heart';
import { ValueSplitRows } from '../value-split-rows';
import { useStreamPanel } from '../streaming-settings';

/** Rows revealed per press of "Load more episodes". */
const PAGE_SIZE = 50;

function LiveBadge({ status }: { status: NonNullable<Episode['liveStatus']> }) {
  if (status === 'live') {
    return (
      <span className="stamp shrink-0 whitespace-nowrap text-nostr border-nostr/60 bg-nostr/10 animate-bolt">
        ● LIVE
      </span>
    );
  }
  if (status === 'pending') {
    return <span className="stamp shrink-0 whitespace-nowrap text-bolt border-bolt/60">PENDING</span>;
  }
  return null;
}

function ShareButton({ podcast }: { podcast: Podcast }) {
  return (
    <CopyLinkButton
      url={showShareUrl(podcast.podcastGuid)}
      title="Copy link to this show"
      className="btn-ghost btn-compact"
    />
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
      className="btn-ghost btn-compact"
      title={funding.message || 'Support this show'}
    >
      <CoinIcon /> SUPPORT
    </a>
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
  // `truncated`: the route could not serve the whole feed (PI's per-feed
  // ceiling, or the response byte budget). Rendered at the end of the list —
  // a list that just stops reads as a show that stopped.
  const [data, setData] = useState<{ podcast: Podcast | null; episodes: Episode[]; truncated?: boolean }>({
    podcast: null, episodes: [],
  });
  const [loading, setLoading] = useState(false);
  // A failed load used to fall through to the `not found` branch below, which
  // says the show doesn't exist when what actually happened is that the network
  // dropped. Separate state, separate message, and a way back.
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Generation counter for the feed fetch — the same guard lib/nostr/use-feed.ts
  // and components/podroll.tsx already use. See the effect below for why this
  // one is not merely a render optimisation.
  const feedGenRef = useRef(0);
  const [showBoostOpen, setShowBoostOpen] = useState(false);
  const [boostTrack, setBoostTrack] = useState<Episode | null>(null);
  const [valueOpen, setValueOpen] = useState(false);
  // Episodes open at 10 rows and reveal PAGE_SIZE more per press of a "Load
  // more" button. The Nostr comments feed sits below this list, so a button
  // (not infinite scroll) keeps it at a stable, reachable position on mobile —
  // which is also why the step is bigger than the opening count: /api/feed
  // serves up to PI's full 1000 items, and 10 at a time is a hundred presses
  // to reach the bottom of an archive show.
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
    // setLoading(false) matters on this branch: it returns before the fetch
    // below, so a `loading` left true by a PREVIOUS run was never cleared and
    // the render — which checks `loading` first — sat on "loading episodes…"
    // forever. Reachable whenever a favorite hasn't resolved an id yet, which
    // is exactly the state a slow or failed metadata fetch leaves behind.
    if (!feedId) { setData({ podcast: null, episodes: [] }); setLoading(false); setLoadError(false); return; }
    setLoading(true);
    // The generation guard is a CORRECTNESS gate, not a perf one. Switching
    // shows quickly can land A's response after B's, and the handler below
    // writes `episodeQueue` — the array <TransportControls> computes prev/next
    // from and playNext() traverses. A late response therefore repointed the
    // transport at the previous show while this one was on screen.
    //
    // The `.catch` is the other half. `.finally` does NOT handle rejection, so
    // an offline fetch, a 5xx serving an HTML body, or any r.json() parse
    // failure was an unhandled promise rejection: loading cleared, data stayed
    // empty, and the page rendered `not found`.
    const gen = ++feedGenRef.current;
    setLoadError(false);
    // `loadFeed` rather than a bare fetch, and it also owns the URL: a preview
    // (not-in-PI) feed loads by URL because its synthetic id cannot be resolved
    // server-side, and a PI feed by numeric id. It coalesces a request already
    // in flight for the same feed — which on a cold `?podcast=…&episode=…` deep
    // link is exactly what is happening, because `<HomePage>` puts the show in
    // the store first and this list mounts while `loadEpisodeFromFeed` is still
    // downloading the very same body. Nothing is cached past the promise
    // settling, so the retry button below still re-fetches.
    loadFeed(feedUrl ? { feedUrl } : { feedId })
      .then((d) => {
        if (gen !== feedGenRef.current) return;
        // An `{ error }` body parses fine and would otherwise put `undefined`
        // into the store as the episode queue.
        const episodes = Array.isArray(d?.episodes) ? d.episodes : [];
        if (!d?.podcast) { setLoadError(true); return; }
        setData({ podcast: d.podcast, episodes, truncated: !!d.truncated });
        setEpisodeQueue(episodes);
        // Push the RSS-enriched podcast (funding/medium/podroll) back into the
        // store so the episode detail view — which reads selectedPodcast — shows
        // the SUPPORT link the show page gets. No-op if it's a different show.
        syncSelectedPodcast(d.podcast);
      })
      .catch(() => {
        if (gen === feedGenRef.current) setLoadError(true);
      })
      .finally(() => {
        if (gen === feedGenRef.current) setLoading(false);
      });
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // `reloadKey` is what the retry button below bumps — it re-runs this effect
    // without needing the feed to change.
  }, [feedId, feedUrl, reloadKey, setEpisodeQueue, syncSelectedPodcast]);

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
  // A dropped connection is not the same answer as "this show doesn't exist",
  // and telling a user the second when the first happened sends them looking
  // for a problem that isn't there.
  if (loadError) {
    return (
      <div ref={containerRef} className="text-sm py-8 flex flex-wrap items-center gap-3">
        <span className="text-muted">couldn&apos;t load this show — check your connection</span>
        <button type="button" className="btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
          ↻ retry
        </button>
      </div>
    );
  }
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
      {/* NOT sticky on phones. Pinned, this header plus the app header held 282px
          of an 844px viewport — a third of the screen — and tracks scrolled
          underneath the album art, reading as three stacked layers fighting each
          other. It earns its keep on desktop, where it's ~156px of 900+ and the
          tracklist is long; on a phone it just eats the content.
          `top-` MUST stay sm:-prefixed: `top` on a *relative* element offsets it
          rather than pinning it, so an unprefixed value would shove the whole
          header a header's-height down the page.
          `gap-x-4` keeps the original 16px cover-to-text gap; `gap-y-3`
          reproduces the `mt-3` that came OFF the action cluster when it was
          hoisted out of the text column below. */}
      <header className="relative sm:sticky sm:top-[var(--app-header-h)] z-10 bg-ink/90 backdrop-blur -mx-4 px-4 flex flex-wrap items-start gap-x-4 gap-y-3 pb-4 border-b border-bone/15">
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
          {/* text-lg on phones is sized to the COLUMN, not chosen for looks: the
              cover eats 80px + a 16px gap, leaving ~244px, and one long word
              ("Deprogramming") plus its article overflows that at text-xl and
              above — which orphaned "The" on its own line and pushed the rest
              past the clamp, ellipsizing an ordinary album title. The clamp
              bounds a STICKY header, so it has to stay, but at this size three
              lines hold ~60 characters before anything is lost. */}
          <h2 className="font-display text-lg sm:text-3xl leading-tight font-semibold break-words line-clamp-3 sm:line-clamp-none">
            {data.podcast.title}
          </h2>
          <p className="text-sm text-muted mt-1">{data.podcast.author}</p>
          {/* Both stamps share one wrapper. They are `inline-flex` and each used
              to carry its own `mt-2`, so a preview feed that ALSO has a value
              block rendered them separated by nothing but a JSX whitespace node
              — which collides at 326px. */}
          {(data.podcast.isPreview || data.podcast.value) && (
            <div className="flex flex-wrap items-center gap-2 mt-2">
              {data.podcast.isPreview && (
                <span
                  className="stamp text-muted border-muted/40"
                  title="This feed isn't in Podcast Index — parsed directly from RSS for preview"
                >
                  NOT IN PI · PREVIEW
                </span>
              )}
              {data.podcast.value && (
                <button
                  type="button"
                  onClick={() => setValueOpen((v) => !v)}
                  className="stamp text-bolt border-bolt/60 hover:bg-bolt/10 transition cursor-pointer"
                  aria-expanded={valueOpen}
                  title={valueOpen ? 'Hide split details' : 'Show split details'}
                >
                  ⚡ {data.podcast.value.recipients?.length ?? 0} recipients
                  <span className="ml-1">{valueOpen ? '▾' : '▸'}</span>
                </button>
              )}
            </div>
          )}
        </div>
        {/* A `basis-full` SIBLING of the text column, not a child of it. DOM
            nesting can't be responsive, and nested under the author line this
            cluster is capped at ~230px on a 390px screen — which stacks five
            ~105px controls one-per-line into a ragged column. As a basis-full
            sibling it claims the header's whole width at every breakpoint (the
            header is `flex-wrap` for exactly this). Order is documented in
            docs/ui.md; all five controls stay, none hide behind a menu. */}
        <div className="basis-full flex flex-wrap items-center gap-2">
          <FavHeart podcast={data.podcast} size="md" />
          <ShareButton podcast={data.podcast} />
          <SupportButton podcast={data.podcast} />
          {streamButton}
          {showHasValue && (
            <button
              onClick={() => setShowBoostOpen(true)}
              className="btn-bolt btn-compact"
              title="Boost the show"
            >
              <BoltIcon /> BOOST
            </button>
          )}
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
              <div className="flex gap-2 sm:gap-3 py-3 pr-1 sm:pr-3">
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
                <div className="flex items-center gap-2 min-w-0">
                  {e.liveStatus && <LiveBadge status={e.liveStatus} />}
                  <div className="text-base font-display font-medium leading-tight truncate">{e.title}</div>
                </div>
                {/* Wraps, deliberately NOT truncates: at ~150px the date and
                    duration fit line 1 and `· ⚡ V4V` drops to line 2, whereas a
                    truncate here would silently eat the V4V signal. Without the
                    wrap these spans couldn't shrink below their content and
                    painted out sideways under the BOOST button. */}
                <div className="text-xs text-muted flex flex-wrap gap-x-2 gap-y-0.5 min-w-0 mt-0.5">
                  {e.liveStatus && e.liveStartTime ? (
                    <span className="whitespace-nowrap">
                      {e.liveStatus === 'pending' ? 'starts ' : 'started '}
                      {fmtLiveTime(e.liveStartTime)}
                    </span>
                  ) : (
                    e.datePublished && (
                      <span className="whitespace-nowrap">
                        {fmtDate(e.datePublished)}
                      </span>
                    )
                  )}
                  {e.duration && <span className="whitespace-nowrap">· {fmtDuration(e.duration)}</span>}
                  {e.value && <span className="text-bolt whitespace-nowrap">· ⚡ V4V</span>}
                </div>
                {/* These were bare inline <span>s carrying `mt-0.5`, which does
                    nothing on a non-replaced inline element, and they abutted
                    with only a JSX whitespace node between them when both ran. */}
                {e.socialInteract?.length || e.valueTimeSplits?.length ? (
                  <div className="flex flex-wrap items-center gap-x-2 text-[11px] mt-0.5">
                    {e.socialInteract?.length ? (
                      <span className="text-nostr">💬 discussion</span>
                    ) : null}
                    {e.valueTimeSplits?.length ? (
                      <span className="text-bolt">⚡ {e.valueTimeSplits.length} tracks</span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {hasValueRecipients(e.value) && (
                // Icon-only below sm: — the word cost ~100px of a ~314px row and
                // left the title ~24px ("Vi…", "Co…"). aria-label is REQUIRED
                // now, not decorative: `title` is not an accessible name, so
                // without it this button reads as unlabelled once the word goes.
                <button
                  type="button"
                  onClick={(ev) => { ev.stopPropagation(); setBoostTrack(e); }}
                  className="btn-bolt btn-compact self-center flex-shrink-0 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0"
                  title="Boost this track"
                  aria-label="Boost this track"
                >
                  <BoltIcon />
                  <span className="hidden sm:inline">BOOST</span>
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
          onClick={() => setVisibleCount((c) => Math.min(c + PAGE_SIZE, data.episodes.length))}
          className="btn-ghost w-full mt-3"
        >
          Load more episodes ({remaining})
        </button>
      )}
      {remaining === 0 && data.truncated && (
        <p className="text-muted text-xs mt-3 text-center">
          Older episodes exist, but this feed is longer than the app can load in one go.
        </p>
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
