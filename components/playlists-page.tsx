'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PodcastResults } from '@/components/lists';
import { useApp } from '@/lib/store';
import {
  MUSICL_PUBLISHER_URL,
  COMMUNITY_COLLECTION_URL,
  COMMUNITY_COLLECTION_TITLE,
  loadCollection,
  playlistTrackCount,
} from '@/lib/playlist-collection';
import { isPlaylistMedium } from '@/lib/util';
import type { Podcast } from '@/lib/types';

/** Read by `<HomePage>`'s back control — see `showOrigin` in lib/store.ts. */
const PLAYLISTS_ORIGIN = { path: '/playlists', label: 'playlists' };

/**
 * The collections this page shows, in order.
 *
 * Two, and they are separate SHAPES as well as separate headings: the first is
 * a real publisher feed, so a playlist added there appears the same day with no
 * deploy; the second is a curated URL list, because its playlists have other
 * authors and no publisher feed lists them together. Naming them here rather
 * than inlining two copies of the section is what stops the count line, the
 * shortfall line and the retry drifting apart between them — the fault this
 * module's own header records from when one file held two copies of the fetch.
 */
/**
 * How many rows get a track count, and how many of those run at once.
 *
 * Sized against `/api/playlist`'s own 30-per-minute per-IP limit, which this
 * page SHARES with opening a playlist. 12 across BOTH sections leaves the
 * visitor most of the budget for the thing they came to do.
 */
const MAX_COUNTED_ROWS = 12;
const COUNT_CONCURRENCY = 3;

const SECTIONS: readonly { url: string; heading: string; blurb: string }[] = [
  {
    url: MUSICL_PUBLISHER_URL,
    heading: "ChadF's playlists",
    blurb: 'Published as a Podcasting 2.0 publisher feed, so this list updates itself.',
  },
  {
    url: COMMUNITY_COLLECTION_URL,
    heading: COMMUNITY_COLLECTION_TITLE,
    // NOT "made by other people": entry 2 of COMMUNITY_PLAYLIST_URLS is ChadF's
    // own, made on v4vmusic rather than by the tooling that writes the publisher
    // feed. Every visitor read a false attribution about that row — the same
    // class of wrong claim splitting the collections was meant to prevent, just
    // pointing the other way. What is true of ALL of them is the host.
    blurb: 'Built on other hosts, and mostly by other people in the V4V community.',
  },
];

/**
 * One collection's rows, its count, and how much of it is missing.
 *
 * Held per section rather than merged into one list, because every number on
 * screen is a claim about a NAMED collection: merging them would let one feed's
 * outage print a short total over the other's complete one, with nothing saying
 * which half was short.
 */
interface SectionState {
  playlists: Podcast[] | null;
  /**
   * How many entries the collection NAMES, which is not always how many
   * resolved. See `loadCollection`: a child Podcast Index cannot answer for and
   * whose RSS also fails to read is dropped, silently and on purpose, so one
   * dead entry does not cost the reader the others. Holding this is what stops
   * the count line stating the survivors as the whole.
   */
  listed: number;
  /**
   * Podcast Index was rate limiting, so these rows were read from the feeds'
   * own RSS. The list is COMPLETE and the documents are authoritative; what is
   * missing is PI's id and guid, so `<FavHeart>` withholds the favorite for one
   * load and the rows must not claim `NOT IN PI` about feeds nobody asked about.
   */
  noPi: boolean;
  loading: boolean;
  failed: boolean;
}

const INITIAL: SectionState = {
  playlists: null, listed: 0, noPi: false, loading: true, failed: false,
};

/**
 * The curated playlist collections, as a page.
 *
 * Four states per section, and conflating any two of them reproduces a bug this
 * repo has already paid for twice (`<EmptyLibrary>`, and the favorites degraded
 * read): loading is not empty, a failed load is not "this collection lists
 * nothing", and no count may be printed over either — "0 playlists" above a load
 * error states as fact the very thing we just said we could not determine.
 */
export function PlaylistsPage() {
  const [sections, setSections] = useState<readonly SectionState[]>(
    () => SECTIONS.map(() => INITIAL),
  );
  /**
   * feed URL → deduped track count, filled in after the rows paint.
   *
   * One map for the whole page, keyed by feed URL, so a playlist listed by both
   * collections is counted once. A row missing from this map renders NO count,
   * which covers both "still asking" and "never got an answer". Those are the
   * same thing on screen and deliberately so: the alternative is a number we did
   * not learn.
   */
  const [counts, setCounts] = useState<Record<string, number>>({});
  const selectPodcast = useApp((s) => s.selectPodcast);
  const setShowOrigin = useApp((s) => s.setShowOrigin);
  const router = useRouter();

  const patch = useCallback((i: number, next: Partial<SectionState>) => {
    setSections((prev) => prev.map((s, j) => (j === i ? { ...s, ...next } : s)));
  }, []);

  const load = useCallback(async (i: number) => {
    patch(i, { loading: true, failed: false });
    const collection = await loadCollection(SECTIONS[i].url);
    if (!collection) {
      // Keep whatever is already on screen. A retry that fails must not empty a
      // list the visitor can still read.
      patch(i, { loading: false, failed: true });
      return;
    }
    patch(i, {
      loading: false,
      playlists: collection.feeds,
      listed: collection.listed,
      noPi: collection.couldNotAskPi,
    });
  }, [patch]);

  useEffect(() => { SECTIONS.forEach((_, i) => void load(i)); }, [load]);

  /**
   * Track counts, one request per row, AFTER the collections have painted.
   *
   * Deliberately not folded into `/api/publisher`: that route answers for any
   * publisher feed and would then read every child's RSS to serve a number only
   * this page shows. Deliberately not awaited before painting either — a count
   * is an annotation, and holding the covers back for it would trade the whole
   * page against a line of small text.
   *
   * **The ceiling is NOT cosmetic, which an earlier version of this comment
   * claimed.** `/api/playlist` allows 30 per minute per IP and it is the same
   * bucket the visitor's next TAP on a row spends — so an uncapped pass does
   * not merely lose annotations, it makes opening a playlist 429 and
   * `<EpisodeList>` render its load error. Two sections make that likelier, not
   * less: 17 rows today, and both lists grow without a deploy.
   *
   * So the pass is CAPPED and the rest of the rows simply show no count, which
   * is how an annotation should degrade. `COUNT_CONCURRENCY` spreads even those
   * rather than firing them as one spike.
   *
   * **The dependency is a STRING, and that is the other half.** `sections` is a
   * new array on every `patch`, and mount produces four of them (two loading,
   * then each collection resolving) — so depending on it cancelled every
   * request in flight and re-issued the whole set, four times over. One RETRY
   * past `/api/playlist`'s 60 s `max-age` then doubled it again. `urlKey`
   * changes only when the set of countable URLs does.
   *
   * `askedRef` is what stops a re-run re-asking about a URL already answered,
   * without making `counts` a dependency (which would re-arm the effect on
   * every arriving count).
   *
   * Gated on `isPlaylistMedium` because a publisher feed may list albums, and
   * "tracks" is the wrong noun for one. Deduped by URL across the sections.
   */
  const urlKey = useMemo(
    () => [...new Set(
      sections
        .flatMap((s) => s.playlists ?? [])
        .filter((p) => p.url && isPlaylistMedium(p))
        .map((p) => p.url!),
    )].join('\n'),
    [sections],
  );
  const askedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!urlKey) return;
    // **The cap is a TOTAL for the page, not a per-run one**, and the claim is
    // made EAGERLY. Both matter because this effect legitimately runs more than
    // once: the two collections resolve in separate tasks, so `urlKey` grows,
    // and React's development StrictMode invokes every effect twice. Claiming a
    // URL only as a worker reached it left the rest unclaimed, so the next run
    // re-asked about requests still in flight — measured at 30 requests for 17
    // rows, worse than the uncapped version it replaced.
    const budget = MAX_COUNTED_ROWS - askedRef.current.size;
    if (budget <= 0) return;
    const urls = urlKey.split('\n')
      .filter((u) => !askedRef.current.has(u))
      .slice(0, budget);
    if (!urls.length) return;
    for (const u of urls) askedRef.current.add(u);

    let live = true;
    let next = 0;
    const worker = async () => {
      while (live) {
        const url = urls[next++];
        if (!url) return;
        const total = await playlistTrackCount(url);
        if (!live || total === null) continue;
        setCounts((prev) => (prev[url] === total ? prev : { ...prev, [url]: total }));
      }
    };
    void Promise.allSettled(
      Array.from({ length: Math.min(COUNT_CONCURRENCY, urls.length) }, worker),
    );
    return () => { live = false; };
  }, [urlKey]);

  /**
   * Open a playlist: set the store, THEN navigate to `/`.
   *
   * Never `router.push('/?podcast=…')`. The show view is `<HomePage>` state and
   * the Zustand store is module-level, so this is a handoff rather than a
   * navigation with a payload — `<HomePage>`'s restore effect early-returns on
   * an existing selection, so a visitor who had opened any show earlier would
   * have their param silently ignored and land back on that show.
   */
  function openPlaylist(p: Podcast) {
    selectPodcast(p);
    // AFTER selectPodcast, never before: that action clears `showOrigin` so an
    // ordinary selection resets it without knowing the field exists. This is
    // what makes the show page offer "← back to playlists" rather than a
    // results list the visitor never saw.
    setShowOrigin(PLAYLISTS_ORIGIN);
    router.push('/');
  }

  return (
    <>
      <h1 className="headline text-3xl sm:text-4xl">playlists</h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-bone/80">
        Curated Podcasting 2.0 playlists. Every track lives in its own artist&apos;s feed, so a
        boost pays the artist, not the list.
      </p>

      {SECTIONS.map((section, i) => {
        const state = sections[i];
        const rows = state.playlists ?? [];
        // Never negative: `listed` is 0 before the first successful load, and an
        // older deploy of the route reports it as the row count rather than as 0.
        const missing = Math.max(0, state.listed - rows.length);
        return (
          <section key={section.url} className="mt-8">
            <h2 className="font-display text-lg">{section.heading}</h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">{section.blurb}</p>

            {/* The count states what is on screen, and only once it is known. It
                is suppressed while loading and suppressed on a failure, for the
                reason the publisher aside on `/` suppresses it: a number over an
                error is a claim about the collection, and the error says we have
                none. */}
            {(state.loading || !state.failed) && (
              <div className="text-[11px] uppercase tracking-widest text-muted mt-4 mb-2 px-1">
                {state.loading
                  ? 'loading playlists…'
                  : missing > 0
                    ? `${rows.length} of ${state.listed} playlists`
                    : `${rows.length} playlists`}
              </div>
            )}

            {/* A partial collection says so, in the same breath as the count.
                `/api/publisher` drops a child it can neither find in Podcast
                Index nor read from RSS, which is right — one dead entry must not
                cost the reader the other nine — but the survivors are then
                indistinguishable from the whole, and this line would otherwise
                print a short number as a fact about the collection. Reported
                2026-08-29 as "4 playlists" over a collection of eleven, while
                Podcast Index was rate limiting.
                It is not the load ERROR: the fetch succeeded and the rows below
                are real, so this sits quietly under the count rather than
                replacing the list, and it offers the same retry because the
                usual cause is transient. */}
            {!state.loading && !state.failed && missing > 0 && (
              <p className="text-xs text-muted mb-3 px-1 flex flex-wrap items-center gap-3">
                <span>
                  {missing === 1
                    ? "1 more couldn't be loaded just now"
                    : `${missing} more couldn't be loaded just now`}
                </span>
                <button type="button" onClick={() => void load(i)} className="btn-ghost btn-compact">
                  ↻ RETRY
                </button>
              </p>
            )}

            {/* Above the list, not instead of it: a retry that fails still
                leaves the previously loaded rows readable underneath. */}
            {state.failed && (
              <p className="text-sm py-4 px-1 flex flex-wrap items-center gap-3">
                <span className="text-muted">couldn&apos;t load these — check your connection</span>
                <button type="button" onClick={() => void load(i)} className="btn-ghost btn-compact">
                  ↻ RETRY
                </button>
              </p>
            )}

            {state.loading && !rows.length ? null : rows.length ? (
              <PodcastResults
                feeds={rows}
                selected={null}
                onSelect={openPlaylist}
                piUnasked={state.noPi}
                meta={(p) => {
                  const n = p.url ? counts[p.url] : undefined;
                  return n === undefined ? null : `${n.toLocaleString()} tracks`;
                }}
              />
            ) : state.failed ? null : (
              // Not "no playlists" in the largest type on the page: this is
              // reachable only once the fetch SUCCEEDED and the feed genuinely
              // listed nothing, which is a different sentence from the failure
              // above.
              <p className="text-muted text-sm py-4 px-1">this collection lists nothing</p>
            )}
          </section>
        );
      })}
    </>
  );
}
