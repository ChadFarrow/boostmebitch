'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PodcastResults } from '@/components/lists';
import { useApp } from '@/lib/store';
import { MUSICL_PUBLISHER_URL, loadCollection, playlistTrackCount } from '@/lib/playlist-collection';
import { isPlaylistMedium } from '@/lib/util';
import type { Podcast } from '@/lib/types';

/** Read by `<HomePage>`'s back control — see `showOrigin` in lib/store.ts. */
const PLAYLISTS_ORIGIN = { path: '/playlists', label: 'playlists' };

/**
 * How many rows get a track count, and how many of those run at once.
 *
 * Sized against `/api/playlist`'s own 30-per-minute per-IP limit, which this
 * page SHARES with opening a playlist. 12 leaves the visitor most of the budget
 * for the thing they came to do; the concurrency stops even those twelve
 * arriving as one spike beside `<EpisodeList>`'s own paging.
 */
const MAX_COUNTED_ROWS = 12;
const COUNT_CONCURRENCY = 3;

/**
 * The curated playlist collection, as a page.
 *
 * Four states, and conflating any two of them reproduces a bug this repo has
 * already paid for twice (`<EmptyLibrary>`, and the favorites degraded read):
 * loading is not empty, a failed load is not "this collection lists nothing",
 * and no count may be printed over either — "0 playlists" above a load error
 * states as fact the very thing we just said we could not determine.
 */
export function PlaylistsPage() {
  const [playlists, setPlaylists] = useState<Podcast[] | null>(null);
  /**
   * How many entries the collection NAMES, which is not always how many
   * resolved. See `loadCollection`: a child Podcast Index cannot answer for and
   * whose RSS also fails to read is dropped, silently and on purpose, so one
   * dead entry does not cost the reader the other nine. Holding this is what
   * stops the count line stating the survivors as the whole.
   */
  const [listed, setListed] = useState(0);
  /**
   * Podcast Index was rate limiting, so these rows were read from the feeds'
   * own RSS. The list is complete and the documents are authoritative; what is
   * missing is PI's id and guid, so `<FavHeart>` withholds the favorite for one
   * load and the rows must not claim `NOT IN PI` about feeds nobody asked about.
   *
   * It drives the stamp and nothing else. It carried a line of explanation too,
   * removed at Chad's direction 2026-08-29: the state lasts one load, the answer
   * is `no-store` so a reload really re-asks, and a paragraph about an upstream
   * rate limit is not what this page is for. The FALSE stamp was the actual bug
   * — a missing heart is a small silence, a wrong claim is not.
   */
  const [noPi, setNoPi] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  /**
   * feed URL → deduped track count, filled in after the rows paint.
   *
   * A row missing from this map renders NO count, which covers both "still
   * asking" and "never got an answer". Those are the same thing on screen and
   * deliberately so: the alternative is a number we did not learn.
   */
  const [counts, setCounts] = useState<Record<string, number>>({});
  const selectPodcast = useApp((s) => s.selectPodcast);
  const setShowOrigin = useApp((s) => s.setShowOrigin);
  const router = useRouter();

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    const collection = await loadCollection(MUSICL_PUBLISHER_URL);
    setLoading(false);
    if (!collection) {
      // Keep whatever is already on screen. A retry that fails must not empty a
      // list the visitor can still read.
      setFailed(true);
      return;
    }
    setPlaylists(collection.feeds);
    setListed(collection.listed);
    setNoPi(collection.couldNotAskPi);
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * Track counts, one request per row, AFTER the collection has painted.
   *
   * Deliberately not folded into `/api/publisher`: that route answers for any
   * publisher feed and would then read every child's RSS to serve a number only
   * this page shows. Deliberately not awaited before painting either — a count
   * is an annotation, and holding ten covers back for it would trade the whole
   * page against a line of small text.
   *
   * Gated on `isPlaylistMedium` because a publisher feed may list albums, and
   * "tracks" is the wrong noun for one. `allSettled` because a row that fails
   * must not take the other nine with it; `playlistTrackCount` already answers
   * null rather than throwing, so this is belt and braces.
   *
   * **CAPPED, and the cap is what keeps the feature working.** Every one of
   * these is a `/api/playlist` request, and that route allows 30 per minute per
   * IP — the same bucket the visitor's next TAP on a row spends. The collection
   * is a publisher feed capped server-side at `MAX_PUBLISHER_ALBUMS` (100) and
   * the whole design is that a playlist added there appears here the same day
   * with no deploy, so "there are only eleven today" is not a bound. Past 30
   * rows an uncapped burst exhausts the budget on a cold first visit: the
   * surplus counts vanish silently, and then opening a playlist 429s and
   * `<EpisodeList>` renders its load error. The annotation would have taken out
   * the page it annotates.
   *
   * So a bounded number of rows get a count and the rest simply do not, which
   * is the right way for an annotation to degrade. `CONCURRENCY` keeps even
   * that within the per-minute budget rather than firing it as one spike.
   */
  useEffect(() => {
    if (!playlists?.length) return;
    let live = true;
    const rows = playlists
      .filter((p) => p.url && isPlaylistMedium(p))
      .slice(0, MAX_COUNTED_ROWS);
    // A worker pool rather than `Promise.allSettled` over everything: same
    // total requests, spread out. Each worker takes the next index until the
    // list runs out, and every worker stops the moment the effect is cleaned up.
    let next = 0;
    const worker = async () => {
      while (live) {
        const p = rows[next++];
        if (!p) return;
        const total = await playlistTrackCount(p.url!);
        if (!live || total === null) continue;
        setCounts((prev) => (prev[p.url!] === total ? prev : { ...prev, [p.url!]: total }));
      }
    };
    void Promise.allSettled(
      Array.from({ length: Math.min(COUNT_CONCURRENCY, rows.length) }, worker),
    );
    return () => { live = false; };
  }, [playlists]);

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

  const rows = playlists ?? [];
  // Never negative: `listed` is 0 before the first successful load, and an
  // older deploy of the route reports it as the row count rather than as 0.
  const missing = Math.max(0, listed - rows.length);

  return (
    <>
      <h1 className="headline text-3xl sm:text-4xl">playlists</h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-bone/80">
        Curated Podcasting 2.0 playlists. Every track lives in its own artist&apos;s feed, so a
        boost pays the artist, not the list.
      </p>

      {/* The count states what is on screen, and only once it is known. It is
          suppressed while loading and suppressed on a failure, for the reason
          the publisher aside on `/` suppresses it: a number over an error is a
          claim about the collection, and the error says we have none. */}
      {(loading || !failed) && (
        <div className="text-[11px] uppercase tracking-widest text-muted mt-6 mb-2 px-1">
          {loading
            ? 'loading playlists…'
            : missing > 0
              ? `${rows.length} of ${listed} playlists`
              : `${rows.length} playlists`}
        </div>
      )}

      {/* A partial collection says so, in the same breath as the count.
          `/api/publisher` drops a child it can neither find in Podcast Index
          nor read from RSS, which is right — one dead entry must not cost the
          reader the other nine — but the survivors are then indistinguishable
          from the whole, and this line would otherwise print a short number as
          a fact about the collection. Reported 2026-08-29 as "4 playlists" over
          a collection of eleven, while Podcast Index was rate limiting.
          It is not the load ERROR: the fetch succeeded and the rows below are
          real, so this sits quietly under the count rather than replacing the
          list, and it offers the same retry because the usual cause is
          transient. */}
      {!loading && !failed && missing > 0 && (
        <p className="text-xs text-muted mb-3 px-1 flex flex-wrap items-center gap-3">
          <span>
            {missing === 1
              ? "1 more couldn't be loaded just now"
              : `${missing} more couldn't be loaded just now`}
          </span>
          <button type="button" onClick={() => void load()} className="btn-ghost btn-compact">
            ↻ RETRY
          </button>
        </p>
      )}

      {/* Above the list, not instead of it: a retry that fails still leaves the
          previously loaded rows readable underneath. */}
      {failed && (
        <p className="text-sm py-4 px-1 flex flex-wrap items-center gap-3">
          <span className="text-muted">couldn&apos;t load these — check your connection</span>
          <button type="button" onClick={() => void load()} className="btn-ghost btn-compact">
            ↻ RETRY
          </button>
        </p>
      )}

      {loading && !rows.length ? null : rows.length ? (
        <PodcastResults
          feeds={rows}
          selected={null}
          onSelect={openPlaylist}
          piUnasked={noPi}
          meta={(p) => {
            const n = p.url ? counts[p.url] : undefined;
            return n === undefined ? null : `${n.toLocaleString()} tracks`;
          }}
        />
      ) : failed || listed > 0 ? null : (
        // **Gated on `listed`, never on how many rows rendered.** "Nothing" is a
        // claim about the COLLECTION, and `rows.length === 0` is a fact about
        // what we managed to resolve — the two part company exactly when the
        // page is least able to tell. With Podcast Index rate limiting and the
        // RSS repair also failing, `listed` is 11 and `rows` is empty, and this
        // branch printed "this collection lists nothing" directly under "0 of 11
        // playlists" and "11 more couldn't be loaded just now": three lines, two
        // of them contradicting the third, and the confident one wrong.
        //
        // With `listed > 0` the shortfall line above already carries the whole
        // story and its own retry, so there is nothing left to say here.
        <p className="text-muted text-sm py-4 px-1">this collection lists nothing</p>
      )}
    </>
  );
}
