'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { loadEpisodeFromFeed } from '@/lib/podcast-meta';
import {
  advanceMarks, epKey, pruneMarks, selectNewEpisodes, sinceForBatch,
} from '@/lib/util';
import { fmtDate, fmtDuration } from '@/lib/format';
import { PodcastCover } from './podcast-cover';
import { NoteQueueButton } from './note-queue-button';
import { CollapsibleHeading, useCollapsedGroups } from './lists/grouping';
import type { Episode, NewEpisodeMarks } from '@/lib/types';

/**
 * "New episodes" — what came out on your favorites since you last looked.
 *
 * **IT IS A SECTION, NOT A TAB.** `/favorites`' tab strip is `groupByMedium`'s
 * own output, and injecting a synthetic key would make it a hand-written list
 * again. It also stays out of `tab` / `sort` / `split`: those three describe
 * the LIBRARY, this describes the wire. A medium filter that hid a new episode
 * would be a filter hiding a notification, which is worse than a filter hiding
 * a row. It is always newest-first, because that is what "new" means.
 *
 * **ONE REQUEST ANSWERS BOTH QUESTIONS.** There is no "has this feed changed"
 * step: `/api/new-episodes` takes the feed ids and a `since` and returns the
 * records. See that route for why — the short version is that both caches
 * between this app and Podcast Index hold podcast records for seven days, so
 * any freshness field of ours would have reported "nothing new" confidently.
 *
 * **A NEGATIVE CLAIM IS ONLY MADE WHEN IT IS EARNED.** "Nothing new" appears
 * only when every feed asked about came back covered. A feed PI could not be
 * asked about is named, never counted as quiet — the same rule
 * `<FavoritesSyncNotice>` follows one surface up, and the same one
 * `<FavoritesPage>`'s own header doc states about "Nothing saved yet."
 */

/** The freshness check runs at most this often. `checkedAt` lives on disk, so
 *  this survives a reload and is shared across tabs — a tab-switcher costs
 *  nothing. */
const CHECK_MIN_MS = 15 * 60 * 1000;
/** One request's worth of feeds; the route caps at the same number, so sending
 *  more would be silently truncated there instead of here. A library larger than
 *  this is covered over successive passes rather than partly for ever — see the
 *  stalest-first order in `check`. */
const MAX_FEEDS = 100;
/**
 * How long the ask set must hold still before the first check.
 *
 * `favorites` is replaced WHOLESALE on every mutation, and a cold hydration
 * resolves each show's Podcast Index id one at a time — so the askable list goes
 * 0, 1, 2, … 213 as a series of new objects. Without a settle window the first
 * check ran against whichever prefix existed on the mount tick, stamped
 * `checkedAt`, and every later pass was then refused by the throttle below: the
 * user was told "Nothing new" about a library the app had asked about three
 * shows of. It self-corrected fifteen minutes later, which is what made it worse.
 */
const SETTLE_MS = 1200;
/** Rows revealed at a time. A BYTES cap, not a tidiness one: each row mounts a
 *  `<PodcastCover>` against third-party artwork, which is the same reason
 *  `useRevealed` exists on the page this sits in. */
const PAGE = 12;

type Phase = 'idle' | 'checking' | 'done' | 'failed';

export function FavoritesNewEpisodes() {
  const favorites = useApp((s) => s.favorites);
  const identity = useApp((s) => s.identity);
  const [mounted, setMounted] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [rows, setRows] = useState<Episode[]>([]);
  const [uncovered, setUncovered] = useState(0);
  /** Askable shows this pass deliberately did not ask about, because the library
   *  is larger than `MAX_FEEDS`. A DIFFERENT claim from `uncovered`: nothing
   *  failed, we just have not got to them. Counted before the throttle can
   *  return, so a throttled pass cannot say "nothing new" over them either. */
  const [deferred, setDeferred] = useState(0);
  const [record, setRecord] = useState<NewEpisodeMarks>({ checkedAt: 0, marks: {} });
  const [marksSaved, setMarksSaved] = useState(true);
  const [shown, setShown] = useState(PAGE);
  const [collapsed, toggleCollapsed] = useCollapsedGroups();
  // React 19 double-invokes effects in development. Without this the check
  // fires twice on every mount and the second one is refused by the throttle,
  // which looks like the throttle working when it is really hiding a bug.
  const running = useRef(false);

  useEffect(() => setMounted(true), []);

  const npub = identity?.npub ?? null;

  /**
   * A STABLE key over the ASK SET, never the `favorites` object.
   *
   * The store replaces `favorites` wholesale on every mutation
   * (`{ ...s.favorites, [guid]: p }`), so a `check` that depended on the object
   * was a new function on every heart toggle — and this section renders on
   * `/favorites`, which is where hearts get toggled. The effect below then
   * re-ran each time. Only the set of feed ids we would ask about can change
   * the answer, so that is what the effect watches.
   */
  const askKey = useMemo(
    () =>
      Object.values(favorites)
        // `id` is 0 until this device resolves one — the same filter
        // `<LivePage>`'s `favIdList` makes, and for the same reason: a feed with
        // no PI id cannot be asked about.
        .filter((f) => f.id > 0)
        .map((f) => f.id)
        .sort((a, b) => a - b)
        .join(','),
    [favorites],
  );

  // Reads the live store rather than closing over `favorites`, so it is stable
  // for a given account. `askKey` is what re-arms the effect below.
  const check = useCallback(async (force: boolean) => {
    if (running.current) return;
    const stored = storage.newEpisodeMarks.get(npub);
    setRecord(stored);

    const favs = useApp.getState().favorites;
    const askable = Object.values(favs).filter((f) => f.id > 0);
    if (!askable.length) { setPhase('done'); return; }

    /**
     * STALEST MARK FIRST, then slice.
     *
     * The slice used to be over `Object.values` insertion order, so a library
     * over `MAX_FEEDS` had the same arbitrary hundred checked on every pass and
     * the rest were never asked about at all. Ordering by mark makes the
     * truncation self-correcting: a feed just covered has the newest mark and
     * goes to the back, so 227 favorites are fully covered in three passes and
     * stay covered. A feed with NO mark sorts first, which is right — it is the
     * one we know least about.
     */
    const ordered = [...askable].sort(
      (a, b) => (stored.marks[a.podcastGuid] ?? 0) - (stored.marks[b.podcastGuid] ?? 0),
    );
    const feeds = ordered.slice(0, MAX_FEEDS);
    // BEFORE the throttle can return, so a throttled pass cannot claim "nothing
    // new" over a tail it never asked about. This number needs no request.
    setDeferred(askable.length - feeds.length);

    if (!force && Date.now() - stored.checkedAt < CHECK_MIN_MS) {
      // Inside the throttle: say nothing new rather than re-asking. The marks
      // are what the last pass left, so this is not a claim about now — which
      // is why the heading carries the time of that pass.
      setPhase('done');
      return;
    }

    running.current = true;
    setPhase('checking');
    try {
      const guidByFeedId: Record<number, string> = {};
      for (const f of feeds) guidByFeedId[f.id] = f.podcastGuid;
      const guids = feeds.map((f) => f.podcastGuid);
      const since = sinceForBatch(stored.marks, guids, Date.now());

      const res = await fetch(
        `/api/new-episodes?feeds=${feeds.map((f) => f.id).join(',')}&since=${since}`,
      );
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const episodes: Episode[] = Array.isArray(data.episodes) ? data.episodes : [];
      const covered: number[] = Array.isArray(data.covered) ? data.covered : [];
      const truncated = !!data.truncated;

      setRows(selectNewEpisodes(episodes, stored.marks, guidByFeedId, Date.now()));
      // Against the feeds ASKED ABOUT. The library's tail beyond `MAX_FEEDS` is
      // `deferred`, counted above — folding the two together was how a
      // 227-favorite library got told "Nothing new" about 127 shows no request
      // was ever made for.
      setUncovered(feeds.length - covered.length);

      // The marks advance on EVIDENCE only — a feed that was not covered, a
      // covered feed with no rows, and a truncated pass all leave theirs
      // alone. That rule is `advanceMarks`, pinned by `check:favnew`.
      const coveredGuids = covered.map((id) => guidByFeedId[id]).filter(Boolean);
      let nextMarks = advanceMarks(stored.marks, episodes, coveredGuids, guidByFeedId, truncated);
      /**
       * PRUNING IS A DELETION, so it needs a favorites list worth deleting
       * against. Before this gate it ran against whatever snapshot the pass
       * happened to see, and the pre-hydration snapshot is the cached subset —
       * so a mark for a show still favorited was dropped, and this key's own doc
       * says what that costs: "it re-announces a week of episodes as new."
       *
       * 'idle' and 'loading' both mean a read may still widen the list. For a
       * signed-OUT reader the local cache IS the whole truth and 'idle' is the
       * resting state, so that one prunes. 'degraded' does not: a half this
       * signer could not open is a shorter list for a reason that has nothing to
       * do with what is favorited. Skipping the prune costs only dead weight,
       * which `pruneMarks`' own cap already bounds.
       */
      const sync = useApp.getState().favoritesSync;
      if (!npub || sync === 'ok' || sync === 'off') {
        nextMarks = pruneMarks(nextMarks, Object.keys(favs));
      }
      const next = { checkedAt: Date.now(), marks: nextMarks };
      // Do NOT drop `safeSet`'s answer. Marks held only in the memory mirror
      // work all session and are gone on the next load, so the same episodes
      // come back announced as new — which reads as the feature being broken,
      // never as a storage fault.
      setMarksSaved(storage.newEpisodeMarks.set(npub, next));
      setRecord(next);
      setPhase('done');
    } catch {
      // Keep whatever is painted. A failed check is not an empty library.
      //
      // STAMP `checkedAt` ANYWAY, with the marks untouched. The throttle reads
      // that value, so leaving it alone meant a failed check armed nothing: with
      // Podcast Index down, every heart toggle issued a fresh request — two
      // chunks of fifty feed ids each, no backoff. Bulk-editing twenty
      // favorites during an outage was twenty requests and forty upstream calls.
      // `running` guards concurrent runs, never sequential ones.
      //
      // The marks do NOT advance here, so nothing is claimed as seen. The
      // fifteen minutes buys a backoff, and "try again" below ignores it.
      const next = { ...stored, checkedAt: Date.now() };
      setMarksSaved(storage.newEpisodeMarks.set(npub, next));
      setRecord(next);
      setPhase('failed');
    } finally {
      running.current = false;
    }
  }, [npub]);

  useEffect(() => {
    if (!mounted || !askKey) return;
    // A SETTLE WINDOW, not a plain call. Each change to the ask set restarts it,
    // so a cold hydration's run of `favorites` replacements produces ONE check,
    // against the settled library. See `SETTLE_MS`.
    const t = setTimeout(() => void check(false), SETTLE_MS);
    return () => clearTimeout(t);
  }, [mounted, askKey, check]);

  // NOT gated on being signed in. `identityKey` gives `:guest` for a null npub,
  // exactly as `bmb:favorites` and `bmb:listen_queue` do — so a signed-out
  // reader with favorites gets the same marks, in the same place, and gating
  // here would have been the one surface on this page that disagreed.
  //
  // It DOES hide when nothing can be asked about: a favorite whose `id` is
  // still 0 has no PI feed id, and a heading over an empty list is a claim
  // about somebody's shows that no request was made to earn.
  if (!mounted) return null;
  if (!Object.values(favorites).some((f) => f.id > 0)) return null;

  const key = 'favpage:new';
  const isCollapsed = collapsed.has(key);
  const stale = Date.now() - record.checkedAt >= CHECK_MIN_MS;
  const when = record.checkedAt ? fmtDate(Math.floor(record.checkedAt / 1000)) : null;

  return (
    <section className="mb-4">
      <CollapsibleHeading
        label={
          <span className="flex items-center gap-2">
            <span>NEW EPISODES</span>
            {rows.length > 0 && <span className="text-bolt">{rows.length}</span>}
            {phase === 'checking' && <span className="text-muted normal-case">checking…</span>}
          </span>
        }
        collapsed={isCollapsed}
        onToggle={() => toggleCollapsed(key)}
        controls="fav-new-list"
        className="mb-2"
      />

      {/* The wrapper ALWAYS renders, and only its contents are dropped. An
          `aria-controls` pointing at an unmounted element is a dangling IDREF in
          exactly the collapsed state where `aria-expanded="false"` makes the
          reference matter. `<Favorites>` keeps its `<ul>` `hidden` rather than
          unrendered for this reason and `<FeedSection>` keeps the wrapper; this
          was the one folding surface doing neither. Rows still unmount, which is
          what the fold is for. */}
      <div id="fav-new-list" hidden={isCollapsed}>
        {!isCollapsed && (
          <>
          {/* Every state is named, because the wrong one is a claim about
                somebody's shows that the app had not earned. */}
            {phase === 'checking' && rows.length === 0 && (
              <p className="text-muted text-sm py-3">checking your shows for new episodes…</p>
            )}

            {phase === 'failed' && (
              <p className="text-nostr text-sm py-3">
                Could not check for new episodes.{' '}
                <button type="button" onClick={() => void check(true)} className="underline">
                  try again
                </button>
              </p>
            )}

            {/* NOT "nothing new" — this names how many shows a request was made
                for and did not come back. The two are different claims and only
                one of them is true here. */}
            {phase === 'done' && uncovered > 0 && (
              <p className="text-muted text-sm py-3">
                Could not check {uncovered} of your shows.{' '}
                <button type="button" onClick={() => void check(true)} className="underline">
                  try again
                </button>
              </p>
            )}

            {/* A THIRD claim, and it is not a failure: the library is larger than
                one request's worth, so these shows were not asked about at all.
                Saying "could not check" would blame Podcast Index for a cap of
                ours. The check-the-rest press makes real progress, because the
                ask list is ordered stalest-mark-first — the hundred just covered
                now sort last. */}
            {phase === 'done' && deferred > 0 && (
              <p className="text-muted text-sm py-3">
                {deferred} more {deferred === 1 ? 'show has' : 'shows have'} not been checked yet.{' '}
                <button type="button" onClick={() => void check(true)} className="underline">
                  check the rest
                </button>
              </p>
            )}

            {/* Earned only when every askable show was asked about AND answered.
                `deferred` belongs in this test as much as `uncovered` does. */}
            {phase === 'done' && rows.length === 0 && uncovered === 0 && deferred === 0 && (
              <p className="text-muted text-sm py-3">
                Nothing new{when ? ` since ${when}` : ''}.{' '}
                {stale && (
                  <button type="button" onClick={() => void check(true)} className="underline">
                    check again
                  </button>
                )}
              </p>
            )}

            {!marksSaved && (
              <p className="text-muted text-[11px] pb-2">
                This device could not remember what it showed you — these may come back.
              </p>
            )}

            {rows.length > 0 && (
              <ul className="space-y-2">
                {rows.slice(0, shown).map((e) => (
                  // `epKey`, NOT `guid ?? id`. A feed can publish `<guid></guid>`
                  // and `extractText` returns `''` for it, which `??` keeps — so
                  // every such episode of one feed shared the key `<feedId>:`.
                  // That is a React duplicate key: wrong row reused, wrong row
                  // dropped by SHOW MORE. `epKey` exists for this and three other
                  // queue surfaces already import it.
                  <li key={epKey(e)} className="card flex items-center gap-3 p-3">
                    {/* BOTH SLOTS, never one `||` over the two. `<PodcastCover>`'s
                        `onError` ladder is four rungs and it can only fall
                        through to a source it was handed, so collapsing them
                        threw the feed's art away the moment the episode carried
                        an `image` at all — and an episode image that 404s is
                        exactly when the feed's would have worked.
                        `<EpisodeList>` pairs the same two fields on the same
                        data shape. */}
                    <PodcastCover
                      image={e.image}
                      artwork={e.feedImage}
                      title={e.feedTitle}
                      seed={String(e.feedId)}
                      className="w-12 h-12 flex-shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-display leading-tight truncate">{e.title}</div>
                      <div className="text-[11px] text-muted truncate">
                        {e.feedTitle}
                        {e.datePublished ? ` · ${fmtDate(e.datePublished)}` : ''}
                        {e.duration ? ` · ${fmtDuration(e.duration)}` : ''}
                      </div>
                    </div>
                    {/* `<NoteQueueButton>`, NOT `<QueueButton>`, and the reason
                        is money. These rows are Podcast Index's indexed record,
                        which carries no per-item value block, no
                        `valueTimeSplits` and no `alternateEnclosures` — all of
                        which `/api/feed` merges from the publisher's own RSS.
                        On a music feed per-track splits are the normal case, so
                        queueing the PI record would stream a track to the ALBUM
                        instead of to the artist, silently, days later, out of a
                        queue. So the press round-trips through
                        `loadEpisodeFromFeed` first, exactly as the note card's
                        own queue control does.

                        NO GUID, NO CONTROL. That round trip is a lookup BY guid,
                        so a row without one can never succeed — it used to send
                        `''` and land on RETRY for ever. `<FavEpisodeHeart>` makes
                        the same refusal for the same reason: offering a control
                        that cannot work is worse than not offering it. */}
                    {e.guid ? (
                      <NoteQueueButton
                        episode={e}
                        onQueue={async () => {
                          const loaded = await loadEpisodeFromFeed(e.feedId, e.guid!);
                          if (!loaded?.episode) return false;
                          return useApp.getState().enqueueEpisode(loaded.episode, loaded.podcast);
                        }}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {rows.length > shown && (
              <button
                type="button"
                onClick={() => setShown((n) => n + PAGE)}
                className="btn-ghost w-full mt-2 text-xs"
              >
                SHOW MORE ({rows.length - shown})
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
