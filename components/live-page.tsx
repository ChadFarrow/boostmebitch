'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { fmtLiveTime } from '@/lib/format';
import { useApp } from '@/lib/store';
import { hasValueRecipients, liveShowToEpisode, liveShowToPodcast, payableValue, showShareUrl } from '@/lib/util';
import type { LiveShow } from '@/lib/types';
import { AppHeader } from '@/components/app-header';
import { CopyLinkButton } from '@/components/copy-link-button';
import { FavHeart } from '@/components/fav-heart';
import { LiveBadge } from '@/components/live-badge';
import { PodcastCover } from '@/components/podcast-cover';

/**
 * `/live` — everything on air, from both of this app's live sources.
 *
 * WHY THIS PAGE EXISTS. A `<podcast:liveItem>` used to be visible only after
 * you opened the show: `<EpisodeList>` renders the badge and polls
 * `/api/live-status` for one feed, so finding a live broadcast required already
 * knowing which show to look at. Nostr streams had the opposite treatment — a
 * discovery row on the home page. This gives podcast live items that same reach
 * and gives both sources one destination, reached from the dock.
 *
 * TWO SECTIONS NAMED FOR THEIR PROTOCOL — "Live on RSS" and "Live on Nostr" —
 * NOT ONE INTERLEAVED GRID. They are genuinely two different things and the
 * page says so once, in two headings, rather than badging every card with a
 * source. A `<podcast:liveItem>` has a feed, a value block, a `podcastGuid`, a
 * share URL and a ♡; a kind:30311 stream has an npub, an naddr and its own
 * `/stream/<naddr>` page. One card shape would be wrong for both, and "why does
 * this card have no heart" would have no answer on screen.
 *
 * The two headings are byte-identical in markup on purpose (`<h3>`, the same
 * animated dot, the same type), because siblings that look like siblings are
 * what makes the split read as a distinction rather than as a main list with an
 * appendix under it.
 *
 * `<NostrLiveStreams>` is RENDERED here rather than absorbed. Its two-source
 * union, its paint-first ordering and its per-card play semantics are each a
 * bug already paid for, and the comments recording them are worth more where
 * they are than merged into this file. Moving the row is a change of where it
 * mounts, not a rewrite.
 *
 * NO PAGE-LEVEL "NOTHING IS LIVE". Each section makes only the claim its own
 * data supports: the RSS one says nothing is on air over RSS, and the Nostr
 * renders nothing when it has nothing (its existing rule). A combined claim
 * would need both sources settled, and the relays answer in tens of
 * milliseconds while the PI roster and its RSS pass do not — so the page would
 * announce an empty library over a request still in flight, which is the
 * `<FavoritesPage>` failure arriving on a new surface.
 */

// Same loop as `<NostrLiveStreams>` and `useLiveStatusPoll`: a 60 s interval
// plus visibilitychange/focus, gated on `document.hidden`, with a floor so a
// tab-flick storm cannot turn into a request storm. The route caches for 30 s,
// so the floor is comfortably above it either way.
const REFRESH_MS = 60_000;
const REFRESH_MIN_MS = 45_000;

/** Read by `<HomePage>`'s back control — see `showOrigin` in lib/store.ts. */
const LIVE_ORIGIN = { path: '/live', label: 'live' };

const NostrLiveStreams = dynamic(
  () => import('@/components/nostr-live-streams').then((m) => m.NostrLiveStreams),
  { ssr: false },
);

type LoadState = 'loading' | 'ok' | 'failed';

interface LiveShowsResponse {
  items: LiveShow[];
  unverifiedFeeds: number;
  truncated: boolean;
}

export function LivePage() {
  const [data, setData] = useState<LiveShowsResponse | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const lastLoadRef = useRef(0);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    lastLoadRef.current = Date.now();
    try {
      const res = await fetch('/api/live-shows');
      if (!res.ok) throw new Error(String(res.status));
      const json: LiveShowsResponse = await res.json();
      if (!mountedRef.current) return;
      setData(json);
      setState('ok');
    } catch {
      if (!mountedRef.current) return;
      // Keep whatever we already painted. A retry that fails must not empty a
      // section — the rows on screen were true when they arrived, and the
      // common failure here is a PI 429 that clears within the minute.
      setState('failed');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const maybeLoad = () => {
      if (document.hidden) return;
      if (Date.now() - lastLoadRef.current < REFRESH_MIN_MS) return;
      void load();
    };
    const timer = setInterval(maybeLoad, REFRESH_MS);
    document.addEventListener('visibilitychange', maybeLoad);
    window.addEventListener('focus', maybeLoad);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', maybeLoad);
      window.removeEventListener('focus', maybeLoad);
    };
  }, [load]);

  const items = data?.items ?? [];
  const onAir = items.filter((s) => s.liveStatus === 'live');
  const upcoming = items.filter((s) => s.liveStatus === 'pending');
  const unverified = data?.unverifiedFeeds ?? 0;

  // A heading over nothing is its own small lie — it says "here is the RSS
  // list" and then shows blank. The groups inside already refuse to speak when
  // the route has not answered, so the SECTION has to make the same decision
  // one level up, or it renders an orphan title over the gap where the list
  // would be. Failed with nothing in hand is the case: the banner above
  // already says why, and repeating it as an empty section adds no information.
  const rssSpeaks = state !== 'failed' || items.length > 0;

  return (
    <>
      <AppHeader />
      {/* `--dock-b`, never a `pb-32` literal — see docs/ui.md's dock section.
          Five pages predate the dock and hard-code that padding; this is not
          going to be the sixth. */}
      <main
        className="max-w-7xl mx-auto px-4 pt-8"
        style={{ paddingBottom: 'calc(var(--dock-b) + 8rem)' }}
      >
        <h1 className="headline text-2xl sm:text-3xl mb-1">live now</h1>
        <p className="text-muted text-sm mb-8">
          Podcast shows broadcasting right now, and live streams on Nostr.
        </p>

        {/* Degraded, and said out loud. A guard that silently withholds is
            indistinguishable from a broken one, so this sits ABOVE the
            sections where no fold can hide it. */}
        {state === 'failed' && (
          <div className="card p-3 mb-6 text-sm flex items-center justify-between gap-3 flex-wrap">
            <span className="text-muted">
              Couldn&apos;t check what&apos;s on air just now — this list may be short or stale.
            </span>
            <button type="button" onClick={() => void load()} className="btn-ghost text-xs">
              ↻ RETRY
            </button>
          </div>
        )}

        {/* Section one. The heading matches `<NostrLiveStreams>`'s markup
            exactly — same level, same dot, same type — because the whole point
            of naming them by protocol is that the reader can see they are
            siblings rather than a list and a footnote. */}
        {rssSpeaks && (
        <section className="mb-10">
          <h3 className="font-display text-lg flex items-center gap-2 mb-3">
            <span className="text-nostr animate-bolt text-sm">●</span>
            Live on RSS
          </h3>

          <ShowGroup
            shows={onAir}
            state={state}
            hasData={!!data}
            // The one place this page may say a list is empty. It is scoped to
            // RSS, and only spoken once the route has actually answered — see
            // ShowGroup.
            emptyLine="Nothing is broadcasting on RSS right now."
          />

          <ShowGroup
            heading="Upcoming"
            shows={upcoming}
            state={state}
            hasData={!!data}
            emptyLine={null}
            caption={
              'The next broadcast from shows that are on air right now. Podcast Index publishes ' +
              'no global schedule, so a show that has not started yet may not be here.'
            }
          />

          {/* Inside the section, because both describe THIS list. Between the
              two sections they sit directly above "Live on Nostr" and read as
              a caveat about the streams, which they are not. */}
          {unverified > 0 && (
            <p className="text-muted text-xs">
              {unverified === 1 ? '1 show could' : `${unverified} shows could`} not be checked
              against {unverified === 1 ? 'its' : 'their'} own feed just now, so{' '}
              {unverified === 1 ? 'it' : 'they'} may have finished.
            </p>
          )}

          {data?.truncated && (
            <p className="text-muted text-xs mt-1">
              More shows are live than this page checks at once — the newest are shown.
            </p>
          )}
        </section>
        )}


        <div className="pt-4">
          <NostrLiveStreams />
        </div>
      </main>
    </>
  );
}

function ShowGroup({
  heading,
  shows,
  state,
  hasData,
  emptyLine,
  caption,
}: {
  /** A sub-heading inside a protocol section. Omitted for the section's own
   *  primary list, which the section heading already names. */
  heading?: string;
  shows: LiveShow[];
  state: LoadState;
  hasData: boolean;
  /** What to say when the route answered and this group is genuinely empty.
   *  `null` renders nothing — right for Upcoming, where silence is not a claim
   *  anybody is waiting on. */
  emptyLine: string | null;
  caption?: string;
}) {
  // Three ways to have no rows, and only ONE of them is a claim.
  //
  // `loading` with nothing in hand is skeletons. `failed` with nothing in hand
  // renders NOTHING — the degraded banner above the sections is the honest
  // answer, and saying "no shows are on air" over a request that never landed
  // is the `<FavoritesPage>` failure exactly: it withholds while asserting the
  // opposite, and it self-corrects, so nobody presses a second time.
  //
  // Only `ok` may speak. This was written the obvious way first — a single
  // `unsettled` flag that folded `failed` in with `ok` — and running the app
  // with no Podcast Index credentials is what showed it, because that is the
  // one configuration where the route always fails.
  const canClaimEmpty = state === 'ok';
  const showSkeletons = !hasData && state === 'loading';

  if (!showSkeletons && !shows.length && !(canClaimEmpty && emptyLine)) return null;

  return (
    <div className="mb-6">
      {heading && <h4 className="font-display text-sm text-muted mb-1">{heading}</h4>}
      {caption && <p className="text-muted text-xs mb-3 max-w-2xl">{caption}</p>}

      {showSkeletons ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card h-28 animate-pulse opacity-40" />
          ))}
        </div>
      ) : shows.length ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shows.map((s) => (
            // Keyed by guid where the publisher gave one, because the id a row
            // carries can legitimately change between polls: a verified row is
            // the RSS item, an unverified one is Podcast Index's record.
            <ShowCard key={s.guid ?? `${s.feedId}:${s.title}`} show={s} />
          ))}
        </div>
      ) : (
        <p className="text-muted text-sm">{emptyLine}</p>
      )}
    </div>
  );
}

function ShowCard({ show }: { show: LiveShow }) {
  const router = useRouter();
  const play = useApp((s) => s.play);
  const selectPodcast = useApp((s) => s.selectPodcast);
  const setShowOrigin = useApp((s) => s.setShowOrigin);
  const current = useApp((s) => s.current);
  const isPlaying = useApp((s) => s.isPlaying);

  const episode = liveShowToEpisode(show);
  const podcast = liveShowToPodcast(show);
  const pending = show.liveStatus === 'pending';
  const playable = !pending && !!show.enclosureUrl;
  const isCurrent = !!current && current.episode.guid === show.guid && !!show.guid;

  // `payableValue` rather than `episode.value ?? podcast.value`: one expression
  // decides who a boost pays, everywhere. It falls through to the feed's own
  // block here, which is correct — for a live item the container IS the parent.
  const boostable = hasValueRecipients(payableValue(episode, podcast));

  /**
   * Open the show. Store first, then navigate — never `/?podcast=<guid>`.
   *
   * `<HomePage>`'s restore effect early-returns whenever a selection already
   * exists, and the store is module-level, so a URL handoff is silently ignored
   * for anyone who opened a show earlier in the session.
   */
  function openShow() {
    selectPodcast(podcast);
    // AFTER selectPodcast — that action clears `showOrigin`, so setting it
    // first would set a field the next line wipes.
    setShowOrigin(LIVE_ORIGIN);
    router.push('/');
  }

  return (
    <div className="card p-3 flex gap-3">
      <button
        type="button"
        onClick={() => playable && play(episode, podcast)}
        disabled={!playable}
        title={pending ? 'Not started yet' : `Play ${show.title}`}
        className="shrink-0 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        <PodcastCover
          image={show.image}
          artwork={show.feedImage}
          title={show.feedTitle ?? show.title}
          seed={show.podcastGuid ?? String(show.feedId)}
          // The width is an ALLOWLIST, not a free integer — each (url, width)
          // is a CDN cache key. 160 is the smallest offered and the closest
          // above this 64px box at 2x.
          w={160}
          className="w-16 h-16 rounded"
        />
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <LiveBadge status={show.liveStatus} />
          {!show.verified && (
            <span
              className="stamp shrink-0 whitespace-nowrap text-muted border-line"
              title="This show's own feed did not answer, so this is Podcast Index's word alone."
            >
              UNCHECKED
            </span>
          )}
        </div>

        {/* The SHOW is the primary line. On a directory the reader is scanning
            for the show; on the show's own page the episode is the subject. */}
        <button
          type="button"
          onClick={openShow}
          className="block text-left w-full truncate font-medium hover:text-bolt transition"
          title={`Open ${show.feedTitle ?? show.title}`}
        >
          {show.feedTitle ?? show.title}
        </button>
        {show.feedTitle && show.title !== show.feedTitle && (
          <p className="text-muted text-xs truncate">{show.title}</p>
        )}
        {show.liveStartTime != null && (
          <p className="text-muted text-xs">
            {pending ? 'starts' : 'started'} {fmtLiveTime(show.liveStartTime)}
          </p>
        )}

        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <button
            type="button"
            onClick={() => playable && play(episode, podcast)}
            disabled={!playable}
            className="btn-mini disabled:opacity-60 disabled:cursor-not-allowed"
            title={pending ? 'Not started yet' : undefined}
          >
            {isCurrent && isPlaying ? '❚❚ PLAYING' : '▶ PLAY'}
          </button>
          {/* Both self-gate on a missing podcastGuid and render nothing, which
              is what an unverified row needs: a dead control is worse than no
              control. There is deliberately NO boost button here — a live music
              show's payee moves per track, and only the player follows it. */}
          <FavHeart podcast={podcast} size="sm" nameTarget />
          <CopyLinkButton
            url={showShareUrl(show.podcastGuid)}
            title="Copy link to this show"
            className="btn-mini"
          />
          {boostable && <span className="stamp text-bolt border-bolt/60">V4V</span>}
        </div>
      </div>
    </div>
  );
}
