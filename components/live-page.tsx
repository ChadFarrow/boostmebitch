'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { fmtLiveTime } from '@/lib/format';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import {
  hasValueRecipients, isMusicMedium, isPlaylistMedium, liveShowToEpisode,
  liveShowToPodcast, payableValue, showShareUrl,
} from '@/lib/util';
import type { LiveShow } from '@/lib/types';
import { AppHeader } from '@/components/app-header';
import { CopyLinkButton } from '@/components/copy-link-button';
import { FavHeart } from '@/components/fav-heart';
import { LiveBadge } from '@/components/live-badge';
import { LiveCard, LIVE_GRID } from '@/components/live-card';

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
 * WHERE THE RSS ROWS COME FROM. Three rosters, because Podcast Index indexes
 * currently-broadcasting rows only and `/podcasts/bytag` has no "publishes live
 * items" tag — so there is no global list to ask for. PI's roster, the feeds
 * this server has watched go live recently, and the visitor's own favorites,
 * which this component sends as `?feeds=`. The last one is why a show you
 * follow shows its schedule here, and it also repairs PI's false NEGATIVES for
 * those feeds: a favorited show that is live but missing from the roster is
 * found by reading it directly.
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

type RssTab = 'live' | 'upcoming';

/** The two states a `<podcast:liveItem>` can be in that this page renders.
 *  Same vocabulary and same glyphs as the Nostr strip, deliberately. */
const RSS_TABS = [
  { key: 'live', label: 'Live', icon: '●' },
  { key: 'upcoming', label: 'Upcoming', icon: '◷' },
] as const;

/**
 * How many favorited feeds to ask about per poll.
 *
 * The server caps this again and is the authority; this one keeps the URL
 * short. A library of 227 favorites would otherwise build a query string of
 * every id, which the server would truncate anyway.
 *
 * A slice rather than the whole list, because each feed costs the route a
 * Podcast Index lookup and an 8 MB-capped RSS read, and one request must not
 * turn a big library into a hundred of those. Which slice is the interesting
 * part — see `favIds`.
 */
const MAX_FAVORITE_FEEDS = 20;

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
  /**
   * Upcoming items gathered across polls, keyed by feed and item.
   *
   * The rotating slice below means one response describes only the feeds it
   * happened to ask about, so replacing the list each time would make Upcoming
   * flicker between disjoint sets and never show more than one slice at once.
   * A schedule is stable for days, which is exactly what makes accumulating it
   * safe — and is why only PENDING is accumulated. Live is taken fresh from
   * every response, because "on air" is the one thing that is not stable and a
   * remembered live row would be the forgotten-flag bug all over again.
   *
   * Entries are replaced per feed rather than merged, so a show removed from
   * its own feed disappears the next time that feed is polled.
   */
  const [upcomingSeen, setUpcomingSeen] = useState<Record<number, LiveShow[]>>({});
  const lastLoadRef = useRef(0);
  const mountedRef = useRef(true);
  /**
   * `null` until the reader picks one, so the default can follow the content
   * without overriding a choice they made.
   */
  const [rssTab, setRssTab] = useState<RssTab | null>(null);

  /**
   * Every favorited feed that could plausibly carry a live item, newest first.
   *
   * TWO FILTERS, AND THE SECOND IS THE ONE THAT MAKES THIS AFFORDABLE.
   *
   * `id` is 0 until this device has resolved the guid through Podcast Index, so
   * an unresolved favorite has no feed id to look up and is dropped rather than
   * sent as a zero the route would reject. Favorites work signed out, so none
   * of this is gated on `identity`.
   *
   * Then: **a music album never publishes a `<podcast:liveItem>`.** A library
   * this app is built for is mostly albums and tracks, so filtering by medium
   * typically removes the large majority of a big list before anything is
   * asked about — turning "check my favorites" from a hundred feed reads into a
   * handful. `medium` is absent when unknown, and unknown is KEPT: absent means
   * "not resolved yet", never "not a podcast", and dropping those would quietly
   * exclude every favorite PI has not answered for.
   */
  // The map is selected and the string derived from it in a memo, NOT derived
  // inside the selector: a selector runs on every store write, and <Player> in
  // the root layout writes `positionSec` once a second while audio plays. The
  // returned string compared equal so nothing re-rendered, but the
  // values→filter→sort→map→join ran at 1 Hz for the life of the page, scaling
  // with the library. The map's identity changes only when a favorite does.
  const favorites = useApp((s) => s.favorites);
  const favIdList = useMemo(
    () =>
      Object.values(favorites)
        .filter((f) => f.id > 0)
        .filter((f) => !f.medium || !(isMusicMedium(f) || isPlaylistMedium(f)))
        .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
        .map((f) => f.id)
        .join(','),
    [favorites],
  );

  const identity = useApp((s) => s.identity);
  const boostsTick = useApp((s) => s.boostsTick);

  /**
   * Shows this device has actually boosted, newest first.
   *
   * A stronger signal than a favorite, and free: `bmb:boosts:<npub>` is already
   * on the device, already newest-first and already capped. Somebody who sent
   * sats to a show was listening to it, which is a better predictor of caring
   * when it next goes live than a heart pressed once — and the two lists
   * overlap less than you would think, because boosting does not favorite.
   *
   * Re-read whenever a boost is sent or the identity changes, the same shape
   * `<GlobalNostrFeed>` uses. Per-npub isolation is `storage.boosts`' job.
   *
   * The global version of this list — every show ANYONE has boosted — is public
   * data the read index already holds: boost notes carry
   * `['i', 'podcast:guid:<uuid>']` and `ingest.ts` indexes that tag. It would
   * need a "distinct recently-referenced guids" query, which does not exist
   * (`notesByIdentifier` answers the opposite question), and `services/nostr-
   * index` does not deploy on merge. Named in docs/feeds.md rather than built
   * here.
   */
  const boostIdList = useMemo(
    () =>
      storage.boosts
        .get(identity?.npub)
        .map((b) => b.podcastId)
        .filter((id): id is number => typeof id === 'number' && id > 0)
        .join(','),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity?.npub, boostsTick],
  );

  /**
   * The two lists unioned, favorites first, deduped.
   *
   * Favorites lead because a heart is a statement about the future — "tell me
   * when this is on" — where a boost is a record of the past. Both are the same
   * kind of claim once they reach the route: feed ids to go and read.
   */
  const favPool = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of [...favIdList.split(','), ...boostIdList.split(',')]) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out.join(',');
  }, [favIdList, boostIdList]);

  /**
   * Which slice of that pool this poll asks about.
   *
   * A library bigger than one request can carry would otherwise mean the same
   * twenty feeds are checked forever and everything past them is permanently
   * invisible — which is the complaint this exists to answer. The cursor
   * advances each poll, so a list of any size is fully covered within a few
   * minutes of the page being open, at a constant cost per request.
   *
   * It rides in a ref rather than state: advancing it must not itself trigger
   * a render, and `load` reads it at call time.
   */
  const cursorRef = useRef(0);

  /**
   * The pool, held for `load` to read at call time.
   *
   * Deliberately NOT a dependency of `load`. The slice this poll asks for
   * depends on the cursor, which every poll advances — so computing it during
   * render would make `load` a new function each time, and the effect below
   * would tear down and rebuild the interval and both listeners on every tick.
   * Reading it here keeps `load` stable for the life of the component.
   */
  const favPoolRef = useRef(favPool);
  favPoolRef.current = favPool;

  const load = useCallback(async () => {
    lastLoadRef.current = Date.now();
    const all = favPoolRef.current ? favPoolRef.current.split(',') : [];
    // Wrapped so the window is contiguous around the end of the list.
    const favIds =
      all.length <= MAX_FAVORITE_FEEDS
        ? all.join(',')
        : [...all, ...all]
            .slice(cursorRef.current % all.length, (cursorRef.current % all.length) + MAX_FAVORITE_FEEDS)
            .join(',');
    const askedIds = favIds ? favIds.split(',').map(Number) : [];
    try {
      const res = await fetch(`/api/live-shows${favIds ? `?feeds=${favIds}` : ''}`);
      if (!res.ok) throw new Error(String(res.status));
      const json: LiveShowsResponse = await res.json();
      if (!mountedRef.current) return;
      setData(json);
      setUpcomingSeen((prev) => {
        const next = { ...prev };
        // Every feed this response covered gets its upcoming list REPLACED,
        // including with nothing — that is how an item withdrawn from a feed
        // stops being rendered. Feeds this poll did not ask about keep what
        // they had; they were not described either way.
        for (const id of askedIds) delete next[id];
        for (const s of json.items) {
          if (s.liveStatus !== 'pending') continue;
          (next[s.feedId] ??= []).push(s);
        }
        return next;
      });
      setState('ok');
      // Advance to the next window for the poll after this one.
      cursorRef.current += MAX_FAVORITE_FEEDS;
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
  // Live: only ever what the latest response said. Upcoming: everything seen
  // across the rotation, soonest first.
  const onAir = items.filter((s) => s.liveStatus === 'live');
  const upcoming = Object.values(upcomingSeen)
    .flat()
    .sort((a, b) => (a.liveStartTime ?? 0) - (b.liveStartTime ?? 0));
  const unverified = data?.unverifiedFeeds ?? 0;

  /**
   * Land on content, without hiding the state.
   *
   * Opening on an empty Live tab while four shows sit one press away is a bad
   * first screen, and defaulting to Upcoming instead would normally cost the
   * reader the answer to "is anything on right now". It does not here, because
   * the `● LIVE 0` tab is still on screen saying exactly that — in less space
   * than the sentence would take. An explicit choice always wins.
   */
  const rssActive: RssTab =
    rssTab ?? (onAir.length === 0 && upcoming.length > 0 ? 'upcoming' : 'live');

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
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {/* The heading matches `<NostrLiveStreams>`'s markup exactly — same
                level, same dot, same type — because the whole point of naming
                them by protocol is that the reader can see they are siblings
                rather than a list and a footnote. */}
            <h3 className="font-display text-lg flex items-center gap-2">
              <span className="text-nostr animate-bolt text-sm">●</span>
              Live on RSS
            </h3>
            {/* BOTH TABS ALWAYS, AND THAT IS THE DIFFERENCE FROM THE NOSTR
                STRIP. That one hides a group with nothing in it, which is right
                for a section making no claim — it renders nothing at all when
                empty. This section DOES make one: "nothing is broadcasting on
                RSS right now" is a statement about the world, and hiding the
                tab that carries it would take it off the page exactly when it
                is true. A count of 0 on a visible tab says the same thing in
                less space, and says it without the reader having to switch. */}
            <div className="inline-flex gap-1">
              {RSS_TABS.map((t) => {
                const on = rssActive === t.key;
                const count = t.key === 'live' ? onAir.length : upcoming.length;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setRssTab(t.key)}
                    aria-pressed={on}
                    className={`btn-ghost !px-2.5 !py-1 text-xs ${on ? '!border-nostr text-nostr' : 'text-muted'}`}
                  >
                    <span aria-hidden className="mr-1">{t.icon}</span>
                    {t.label} <span className="opacity-60">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {rssActive === 'live' ? (
            <ShowGroup
              shows={onAir}
              state={state}
              hasData={!!data}
              // The one place this page may say a list is empty. It is scoped
              // to RSS, and only spoken once the route has answered — see
              // ShowGroup.
              emptyLine="Nothing is broadcasting on RSS right now."
            />
          ) : (
            <ShowGroup
              shows={upcoming}
              state={state}
              hasData={!!data}
              // "That we can see", never "nothing is scheduled". Podcast Index
              // publishes no global schedule, so this list is the shows you
              // have favorited or boosted plus whatever is on air — and an
              // empty one is a statement about our reach, not about the world.
              emptyLine="Nothing scheduled that we can see."
              caption={
                favPool
                  ? 'Scheduled broadcasts from the shows you have favorited or boosted, plus ' +
                    'from any show on air right now. Podcast Index publishes no global schedule, ' +
                    'so a show you have done neither with may not be here.'
                  : 'The next broadcast from shows that are on air right now. Podcast Index ' +
                    'publishes no global schedule — favorite a show and its schedule shows up here.'
              }
            />
          )}

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
        <div className={LIVE_GRID}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="card h-28 animate-pulse opacity-40" />
          ))}
        </div>
      ) : shows.length ? (
        <div className={LIVE_GRID}>
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
    <LiveCard
      image={show.image}
      artwork={show.feedImage}
      title={show.feedTitle ?? show.title}
      seed={show.podcastGuid ?? String(show.feedId)}
      onArtClick={playable ? () => play(episode, podcast) : undefined}
      artLabel={playable ? `Play ${show.title}` : undefined}
      badges={
        <>
          <LiveBadge status={show.liveStatus} />
          {!show.verified && (
            <span
              className="stamp shrink-0 whitespace-nowrap text-muted border-line"
              title="This show's own feed did not answer, so this is Podcast Index's word alone."
            >
              UNCHECKED
            </span>
          )}
        </>
      }
      heading={
        /* The SHOW is the primary line. On a directory the reader is scanning
           for the show; on the show's own page the episode is the subject. */
        <button
          type="button"
          onClick={openShow}
          className="block text-left w-full truncate font-medium hover:text-bolt transition"
          title={`Open ${show.feedTitle ?? show.title}`}
        >
          {show.feedTitle ?? show.title}
        </button>
      }
      sub={
        show.feedTitle && show.title !== show.feedTitle ? (
          <p className="text-muted text-xs truncate">{show.title}</p>
        ) : undefined
      }
      meta={
        show.liveStartTime != null ? (
          <p className={`text-xs font-mono ${pending ? 'text-bolt' : 'text-nostr'}`}>
            {pending ? 'starts' : 'started'} {fmtLiveTime(show.liveStartTime)}
          </p>
        ) : undefined
      }
      actions={
        <>
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
        </>
      }
    />
  );
}
