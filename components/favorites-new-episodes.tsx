'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { loadEpisodeFromFeed } from '@/lib/podcast-meta';
import {
  advanceMarks, epKey, mergeNewEpisodeRows, NEW_EPISODES_MAX_FEEDS, pruneMarks, pruneNewRows,
  selectNewEpisodes, sinceForBatch,
} from '@/lib/util';
import { readCappedJson } from '@/lib/capped-body';
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
 * **THE PASS IS SEVERAL REQUESTS, NEVER ONE BIGGER ONE.** The route's feed cap
 * guards an attacker-controlled list length, so a library past it is covered by
 * successive requests of `MAX_FEEDS`, in series, inside the same pass — see
 * `MAX_BATCHES`. Each request keeps its own `since`, its own `covered` set and
 * its own `truncated` flag, so a request that fails costs its own feeds and
 * nothing else.
 *
 * **A NEGATIVE CLAIM IS ONLY MADE WHEN IT IS EARNED.** "Nothing new" appears
 * only when every feed asked about came back covered. A feed PI could not be
 * asked about is named, never counted as quiet — the same rule
 * `<FavoritesSyncNotice>` follows one surface up, and the same one
 * `<FavoritesPage>`'s own header doc states about "Nothing saved yet."
 *
 * **THE LIST IS PERSISTED, AND THE MARKS DESCRIBE IT — not the other way
 * round.** The rows used to live only in React state while the marks went to
 * disk, which made the check consume the list instead of the reader. Three
 * shapes of the same bug, all reported as "I never see a new episode":
 *
 * 1. A visit inside the fifteen-minute throttle returned before `setRows`, so
 *    it painted an empty section over a full `bmb:newmarks` record.
 * 2. `advanceMarks` took the FETCHED rows, so a pass over a hundred shows
 *    marked several hundred episodes as seen and showed `FAV_NEW_CAP` of them.
 * 3. The "Nothing new" line required `deferred === 0`, which a one-request pass
 *    over a library larger than `MAX_FEEDS` could never reach — so the page
 *    said nothing at all about the shows it HAD checked.
 *
 * The rows now round-trip through `storage.newEpisodeMarks`, a pass MERGES into
 * that list rather than replacing it, and a mark may only describe a row the
 * merge kept. A row leaves by aging past the seven-day horizon, by its show
 * being unfavorited, or by the reader pressing CLEAR or a row's ✕. Nothing
 * else retires one.
 *
 * **THE TWO RULES MEET AT THE ORDER OF THE MARK UPDATE**, which is the one
 * thing neither feature can decide alone. Requests are independent, so marks
 * look like per-request work — but the list is CAPPED, so request 3's newer
 * rows can push request 1's out of it. Advancing per request would mark those
 * as seen and then drop them, which is bug 2 again by another route. So the
 * marks are computed ONCE, against the final list, and `truncated` is carried
 * per request through `advanceable`.
 */

/** The freshness check runs at most this often. `checkedAt` lives on disk, so
 *  this survives a reload and is shared across tabs — a tab-switcher costs
 *  nothing. */
const CHECK_MIN_MS = 15 * 60 * 1000;
/**
 * One REQUEST's worth of feeds.
 *
 * The route caps at the same number and that cap is a SECURITY one — `feeds` is
 * attacker-controlled length, and every id past it is one more Podcast Index
 * call on our quota — so raising it there is not how a bigger library gets
 * covered. A library larger than this is covered by successive REQUESTS inside
 * one pass; see `MAX_BATCHES`.
 */
const MAX_FEEDS = NEW_EPISODES_MAX_FEEDS;
/**
 * Requests one pass may issue, and they go out SEQUENTIALLY.
 *
 * `/api/new-episodes` allows 30 requests a minute per IP, a phone and a desktop
 * share one household IP, and each request is already a bounded fan-out of its
 * own upstream — so a pass may not spend that allowance in a parallel burst.
 * Five requests cover 500 shows, which is past any real library. A library
 * larger still is `deferred`, and the stalest-first order in `check` makes the
 * next pass cover the part this one did not.
 */
const MAX_BATCHES = 5;
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

export function FavoritesNewEpisodes({ onOpen }: { onOpen?: (e: Episode) => void }) {
  const favorites = useApp((s) => s.favorites);
  const identity = useApp((s) => s.identity);
  const favoritesSync = useApp((s) => s.favoritesSync);
  const [mounted, setMounted] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [rows, setRows] = useState<Episode[]>([]);
  const [uncovered, setUncovered] = useState(0);
  /** Askable shows this pass deliberately did not ask about, because the library
   *  is larger than `MAX_FEEDS × MAX_BATCHES`. A DIFFERENT claim from
   *  `uncovered`: nothing failed, we just have not got to them. Counted before
   *  the throttle can return, so a throttled pass cannot say "nothing new" over
   *  them either. */
  const [deferred, setDeferred] = useState(0);
  /** How many shows the last pass DID ask about. The counterpart to `deferred`,
   *  and what lets the "nothing new" line name its own scope instead of
   *  withholding the result entirely. Only a library past
   *  `MAX_FEEDS × MAX_BATCHES` can now make the two disagree, but that is the
   *  case the line exists for. */
  const [checked, setChecked] = useState(0);
  /** Feeds asked about so far, out of the feeds this pass will ask about. A pass
   *  over a large library is several requests in series, so "checking…" alone
   *  sits there for seconds with nothing saying it is moving.
   *
   *  NOT the same number as `checked`, though both count feeds: this one moves
   *  DURING a pass and resets at the next one, while `checked` is the settled
   *  scope of the pass that produced what is on screen. A throttled pass writes
   *  `checked` and issues no request at all. */
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [record, setRecord] = useState<NewEpisodeMarks>({ checkedAt: 0, marks: {} });
  const [marksSaved, setMarksSaved] = useState(true);
  const [shown, setShown] = useState(PAGE);
  const [collapsed, toggleCollapsed] = useCollapsedGroups();
  // React 19 double-invokes effects in development. Without this the check
  // fires twice on every mount and the second one is refused by the throttle,
  // which looks like the throttle working when it is really hiding a bug.
  //
  // KEYED BY ACCOUNT, not a boolean: a pass is a minute of sequential requests,
  // and a boolean left true by account A's pass refused account B's first check
  // after a switch.
  const running = useRef<string | null>(null);
  /**
   * Rows the reader removed WHILE a pass was running — by ✕ or by CLEAR.
   *
   * A pass copies `stored.rows` when it starts, merges into that copy, paints it
   * after every request and writes it back at the end. So a row removed during
   * the pass came straight back, painted by the next request and written to
   * disk by the last one. Every paint and the final write filter through this
   * set; the pass empties it when it starts and when it settles.
   */
  const dismissed = useRef<Set<string>>(new Set());

  useEffect(() => setMounted(true), []);

  const npub = identity?.npub ?? null;
  // What the RENDER is showing, read by a pass after each await. See `check`.
  const npubNow = useRef(npub);
  npubNow.current = npub;

  /**
   * PAINT WHAT THIS DEVICE ALREADY FOUND, before any request.
   *
   * Not folded into `check`: that one runs behind `SETTLE_MS` and can return
   * early at the throttle, and both delays are reasons the reader sees an empty
   * section over a full record. Keyed on `npub` alone, so an account switch
   * repaints and nothing else re-runs it — a check that has already landed
   * holds rows at least as fresh as the disk it just wrote.
   */
  useEffect(() => {
    const stored = storage.newEpisodeMarks.get(npub);
    setRecord(stored);
    setRows(stored.rows ?? []);
  }, [npub]);

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

  /**
   * The SHOW's title by PI feed id, from the reader's own favorites.
   *
   * A row cannot name its show on its own: Podcast Index's episode records on
   * this path carry no `feedTitle` (measured 2026-09-21 on a Pixel 6 — none of
   * four rows had one), so every row lost the show from its second line AND
   * from the open control's accessible name, and the line opened on a bare
   * "·". Every row's feed was asked about because it is a favorite, so the
   * title is already in memory; no second request can do better.
   */
  const feedTitles = useMemo(() => {
    const m = new Map<number, string>();
    for (const f of Object.values(favorites)) if (f.id > 0 && f.title) m.set(f.id, f.title);
    return m;
  }, [favorites]);
  const showTitle = (e: Episode) => e.feedTitle || feedTitles.get(e.feedId ?? 0);
  // Joined from the parts that EXIST, so a missing one never leaves a dangling
  // separator at either end.
  const metaLine = (e: Episode) =>
    [
      showTitle(e),
      e.datePublished ? fmtDate(e.datePublished) : null,
      e.duration ? fmtDuration(e.duration) : null,
    ].filter(Boolean).join(' · ');

  // Reads the live store rather than closing over `favorites`, so it is stable
  // for a given account. `askKey` is what re-arms the effect below.
  const check = useCallback(async (force: boolean) => {
    const runKey = npub ?? ':guest';
    if (running.current === runKey) return;
    /**
     * THE PASS WRITES ITS OWN ACCOUNT'S DISK, AND PAINTS ONLY ITS OWN ACCOUNT.
     * The storage writes below use the captured `npub` and were always right;
     * the state setters were not — an account switch mid-pass painted A's new
     * episodes into B's section, and they sat there until B's next pass.
     */
    const onScreen = () => npubNow.current === npub;
    const stored = storage.newEpisodeMarks.get(npub);
    setRecord(stored);

    const favs = useApp.getState().favorites;
    const askable = Object.values(favs).filter((f) => f.id > 0);
    if (!askable.length) { setPhase('done'); return; }

    /**
     * STALEST MARK FIRST, then slice.
     *
     * The slice used to be over `Object.values` insertion order, so a library
     * over the pass ceiling had the same arbitrary shows checked on every pass
     * and the rest were never asked about at all. Ordering by mark makes the
     * truncation self-correcting: a feed just covered has the newest mark and
     * goes to the back, so the tail of a library past `MAX_FEEDS × MAX_BATCHES`
     * is covered by the next pass and stays covered. A feed with NO mark sorts
     * first, which is right — it is the one we know least about.
     */
    const ordered = [...askable].sort(
      (a, b) => (stored.marks[a.podcastGuid] ?? 0) - (stored.marks[b.podcastGuid] ?? 0),
    );
    const asked = ordered.slice(0, MAX_FEEDS * MAX_BATCHES);
    // BEFORE the throttle can return, so a throttled pass cannot claim "nothing
    // new" over a tail it never asked about. These two need no request.
    setDeferred(askable.length - asked.length);
    setChecked(asked.length);

    if (!force && Date.now() - stored.checkedAt < CHECK_MIN_MS) {
      // Inside the throttle: repaint the stored list AND the stored outcome.
      // The outcome half is what a failed pass needs: `checkedAt` is stamped on
      // a total failure too (the backoff below), so a reload inside the window
      // arrived here with `uncovered` at its initial 0 and said "Nothing new
      // since …" about shows no request had come back for.
      // REPAINT, not `setPhase` alone — leaving `rows` at its mount value was
      // the whole first bug. A visit two minutes after a check found a full
      // record on disk, returned here, and rendered an empty section, so the
      // list was only ever visible in the single render that followed a check.
      setRows(stored.rows ?? []);
      setUncovered(stored.uncovered ?? 0);
      setPhase(stored.failed ? 'failed' : 'done');
      return;
    }

    running.current = runKey;
    dismissed.current = new Set();
    const keep = (list: Episode[]) =>
      dismissed.current.size ? list.filter((e) => !dismissed.current.has(epKey(e))) : list;
    setPhase('checking');
    setProgress({ done: 0, total: asked.length });

    const guidByFeedId: Record<number, string> = {};
    for (const f of asked) guidByFeedId[f.id] = f.podcastGuid;

    /**
     * ONE PASS, SEVERAL REQUESTS — never one bigger request.
     *
     * The route's `MAX_FEEDS` is a security cap on an attacker-controlled list
     * length, so the way to cover 217 shows is 3 requests of 100, not 1 request
     * of 217. They run SEQUENTIALLY: the route allows 30 requests a minute per
     * IP, a phone and a desktop share one household IP, and each request is
     * already a bounded fan-out of its own upstream.
     */
    const batches: (typeof asked)[] = [];
    for (let i = 0; i < asked.length; i += MAX_FEEDS) batches.push(asked.slice(i, i + MAX_FEEDS));

    /**
     * THE LIST, accumulated across every request of the pass.
     *
     * It starts from what is already on disk, because a pass ADDS to the list
     * rather than replacing it, and it is what `advanceMarks` is handed below
     * — a mark may only describe a row the merge kept.
     */
    let merged = stored.rows ?? [];
    const coveredIds: number[] = [];
    /**
     * The guids a mark may advance over, collected per request.
     *
     * A request's `truncated` flag describes THAT request: PI's `max` is
     * global across the chunk, so what it dropped lies between the mark and
     * what it returned. Its feeds therefore stay out of this list and their
     * marks hold, while the other requests' feeds settle normally. Collecting
     * them rather than advancing per request is what lets the marks be
     * computed once, against the FINAL list — see below.
     */
    const advanceable: string[] = [];
    // Whether ANY request answered. It is what separates "we checked and there
    // is nothing" from "we could not check" — a pass where every request failed
    // is the `failed` phase, and a pass where one of three failed is a `done`
    // phase carrying an `uncovered` count.
    let answered = false;

    try {
      for (const batch of batches) {
        const guids = batch.map((f) => f.podcastGuid);
        // Per BATCH, not per pass. `sinceForBatch` returns the oldest mark in
        // the set, so one floor over the whole library would ask every request
        // for the least-recently-checked show's window.
        const since = sinceForBatch(stored.marks, guids, Date.now());
        try {
          const res = await fetch(
            `/api/new-episodes?feeds=${batch.map((f) => f.id).join(',')}&since=${since}`,
          );
          if (!res.ok) throw new Error(String(res.status));
          // Capped like every other read in this app (CLAUDE.md): it is our own
          // route, but the bound should be asserted here, not inherited.
          const data = (await readCappedJson(res)) as {
            episodes?: unknown; covered?: unknown; truncated?: unknown;
          };
          const episodes: Episode[] = Array.isArray(data.episodes) ? data.episodes : [];
          const covered: number[] = Array.isArray(data.covered) ? data.covered : [];
          const truncated = !!data.truncated;
          answered = true;
          coveredIds.push(...covered);
          if (!truncated) {
            advanceable.push(...covered.map((id) => guidByFeedId[id]).filter(Boolean));
          }

          // Selected against `stored.marks` — the marks as the pass STARTED —
          // and merged into what the earlier requests found. Both halves
          // matter: selecting against a running `marks` would empty the list as
          // it filled, and replacing rather than merging would make request 3
          // delete what request 1 found.
          const now = Date.now();
          merged = mergeNewEpisodeRows(
            merged,
            selectNewEpisodes(episodes, stored.marks, guidByFeedId, now),
            now,
          );
          // Paint what the pass holds so far, before the next request goes out.
          if (onScreen()) setRows(keep(merged));
        } catch {
          // This request's feeds stay OUT of `covered`, exactly as a chunk the
          // route could not ask about does. A request that failed is not a set
          // of shows with nothing new, and the next request still goes out.
        }
        if (onScreen()) setProgress((p) => ({ done: p.done + batch.length, total: p.total }));
      }

      // Against the feeds ASKED ABOUT. The library's tail beyond the pass
      // ceiling is `deferred`, counted above — folding the two together was how
      // a 227-favorite library got told "Nothing new" about 127 shows no
      // request was ever made for.
      const uncoveredCount = asked.length - coveredIds.length;
      if (onScreen()) setUncovered(uncoveredCount);

      /**
       * MARKS ONCE, OVER THE FINAL LIST — not once per request.
       *
       * Two rules meet here and only this order satisfies both. A mark may
       * only describe a row on the list, and the list is capped: request 3's
       * newer rows can push request 1's out of it. Advancing per request would
       * therefore mark request 1's rows as seen and then drop them, which is
       * the silent consumption this whole file exists to prevent. `truncated`
       * is still honoured per request, through `advanceable`.
       */
      let marks = advanceMarks(stored.marks, merged, advanceable, guidByFeedId, false);

      // The marks above see the UNFILTERED list, and that is deliberate: a row
      // the reader dismissed was shown to them, so its mark must move past it or
      // the next pass fetches it again. Only the rows drop it.
      let nextRows = keep(merged);
      if (answered) {
        /**
         * PRUNING IS A DELETION, so it needs a favorites list worth deleting
         * against. Before this gate it ran against whatever snapshot the pass
         * happened to see, and the pre-hydration snapshot is the cached subset —
         * so a mark for a show still favorited was dropped, and this key's own
         * doc says what that costs: "it re-announces a week of episodes as new."
         *
         * 'idle' and 'loading' both mean a read may still widen the list. For a
         * signed-OUT reader the local cache IS the whole truth and 'idle' is the
         * resting state, so that one prunes. 'degraded' does not: a half this
         * signer could not open is a shorter list for a reason that has nothing
         * to do with what is favorited. Skipping the prune costs only dead
         * weight, which `pruneMarks`' own cap already bounds.
         */
        const sync = useApp.getState().favoritesSync;
        if (!npub || sync === 'ok' || sync === 'off') {
          marks = pruneMarks(marks, Object.keys(favs));
          // The rows get the same gate for the same reason, and they need it
          // MORE than the marks do: a stale mark is dead weight the cap bounds,
          // while a row for an unfavorited show is a row on screen that the
          // reader cannot get rid of.
          nextRows = pruneNewRows(nextRows, Object.values(favs).map((f) => f.id));
          if (onScreen()) setRows(nextRows);
        }
      }

      // STAMP `checkedAt` EVEN WHEN EVERY REQUEST FAILED, with the marks
      // untouched. The throttle reads that value, so leaving it alone meant a
      // failed check armed nothing: with Podcast Index down, every heart toggle
      // issued a fresh pass, no backoff. Bulk-editing twenty favorites during an
      // outage was twenty passes. `running` guards concurrent runs, never
      // sequential ones, and "try again" below ignores the throttle.
      //
      // Do NOT drop `safeSet`'s answer. Marks held only in the memory mirror
      // work all session and are gone on the next load, so the same episodes
      // come back announced as new — which reads as the feature being broken,
      // never as a storage fault.
      //
      // The OUTCOME rides with the stamp, for the throttle's repaint above.
      const next = {
        checkedAt: Date.now(), marks, rows: nextRows,
        uncovered: uncoveredCount, failed: !answered,
      };
      const saved = storage.newEpisodeMarks.set(npub, next);
      if (onScreen()) {
        setMarksSaved(saved);
        setRecord(next);
        // Keep whatever is painted on a total failure. A failed check is not an
        // empty library.
        setPhase(answered ? 'done' : 'failed');
      }
    } finally {
      if (running.current === runKey) {
        running.current = null;
        dismissed.current = new Set();
      }
    }
  }, [npub]);

  /**
   * "I have seen these" — the one control that retires a row early.
   *
   * It clears the ROWS and leaves the MARKS exactly where they are, which is
   * what makes it stick: the marks are already past these episodes, so the next
   * pass does not fetch them again. Clearing the marks as well would re-offer
   * the whole seven-day window on the next check, which is the opposite of what
   * the press asked for.
   *
   * The section needs it because nothing else retires a row now except age (and
   * `dismissRow`, the same press for one row). A
   * list that only drains after seven days is the mirror of the bug this fixes,
   * and the reader would have no way to say "done".
   */
  const clearRows = useCallback(() => {
    // Everything on screen, for a pass that is still running. See `dismissed`.
    for (const e of rows) dismissed.current.add(epKey(e));
    const stored = storage.newEpisodeMarks.get(npub);
    const next = { ...stored, rows: [] };
    setMarksSaved(storage.newEpisodeMarks.set(npub, next));
    setRecord(next);
    setRows([]);
    setShown(PAGE);
  }, [npub, rows]);

  /**
   * CLEAR for ONE row — the ✕ on each row.
   *
   * Same rule as CLEAR: the row goes and the MARKS stay, so the next pass does
   * not fetch it again. It filters the list on DISK, not the list in state,
   * because a pass may have written a newer list since this render. By
   * `epKey`, the same key the rows render under.
   */
  const dismissRow = useCallback((e: Episode) => {
    const k = epKey(e);
    dismissed.current.add(k);
    const stored = storage.newEpisodeMarks.get(npub);
    const next = { ...stored, rows: (stored.rows ?? []).filter((r) => epKey(r) !== k) };
    setMarksSaved(storage.newEpisodeMarks.set(npub, next));
    setRecord(next);
    setRows((list) => list.filter((r) => epKey(r) !== k));
  }, [npub]);

  // A SIGNED-IN library is not settled until the relay read lands. A pass
  // against the cached subset stamps `checkedAt`, and the throttle then refused
  // the check that the widened `askKey` asked for — so shows arriving with the
  // read went unasked for fifteen minutes under "Nothing new since …". 'idle'
  // counts: hydration waits for the NIP-65 write set, and every signed-in load
  // leaves it ('off' included). Signed out, the local cache IS the library.
  const hydrating = !!npub && (favoritesSync === 'idle' || favoritesSync === 'loading');

  useEffect(() => {
    if (!mounted || !askKey || hydrating) return;
    // A SETTLE WINDOW, not a plain call. Each change to the ask set restarts it,
    // so a cold hydration's run of `favorites` replacements produces ONE check,
    // against the settled library. See `SETTLE_MS`.
    const t = setTimeout(() => void check(false), SETTLE_MS);
    return () => clearTimeout(t);
  }, [mounted, askKey, check, hydrating]);

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
            {phase === 'checking' && (
              <span className="text-muted normal-case">
                {progress.total > MAX_FEEDS
                  ? `checking ${progress.done}/${progress.total}…`
                  : 'checking…'}
              </span>
            )}
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

            {/* THE RESULT COMES FIRST, then the caveat about its scope.
                `deferred` used to suppress this line outright, on the reading
                that a negative claim over an unasked show is unearned. The
                claim was right and the remedy was wrong: back when a pass was
                ONE request, a 219-show library could never reach
                `deferred === 0`, so it got the caveat alone with nothing said
                about the hundred shows that WERE checked. That is not a
                withheld claim, it is a blank section — which is what the reader
                reports as the feature not working.

                A pass now covers `MAX_FEEDS × MAX_BATCHES`, so `deferred` is 0
                for any real library and this reads "Nothing new since …". The
                scoped form is what a library past that ceiling gets, and it is
                still earned: "Nothing new from the 500 shows checked". */}
            {phase === 'done' && rows.length === 0 && uncovered === 0 && (
              <p className="text-muted text-sm py-3">
                {deferred > 0
                  ? `Nothing new from the ${checked} ${checked === 1 ? 'show' : 'shows'} checked.`
                  : `Nothing new${when ? ` since ${when}` : ''}.`}{' '}
                {deferred === 0 && stale && (
                  <button type="button" onClick={() => void check(true)} className="underline">
                    check again
                  </button>
                )}
              </p>
            )}

            {/* A THIRD claim, and it is not a failure: the library is larger
                than a whole pass (`MAX_FEEDS × MAX_BATCHES`), so these shows
                were not asked about at all. Saying "could not check" would
                blame Podcast Index for a cap of ours. The check-the-rest press
                makes real progress, because the ask list is ordered
                stalest-mark-first — the shows just covered now sort last. It
                carries the only press worth offering while `deferred` stands,
                which is why the line above withholds its own. */}
            {phase === 'done' && deferred > 0 && (
              <p className="text-muted text-sm py-3">
                {deferred} more {deferred === 1 ? 'show has' : 'shows have'} not been checked yet.{' '}
                <button type="button" onClick={() => void check(true)} className="underline">
                  check the rest
                </button>
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
                    {/* THE ROW OPENS THE EPISODE, and the cover and the text are
                        one control rather than two: they name one destination,
                        and a screen reader should hear one link to it, not two.
                        Its text content IS the accessible name — the title, the
                        show and the date — which is why it carries no
                        `aria-label`. The queue control stays a SIBLING: a button
                        may not contain a button, the rule every episode row in
                        this app already follows.

                        `onOpen` is the page's, not this component's: the handoff
                        is `selectPodcast` → `setShowOrigin` → `router.push('/')`
                        and it has to stay in one place. Without it — a surface
                        that renders this section and passes nothing — the row is
                        a plain `<div>` and reads as text, rather than a control
                        that looks live and does nothing. */}
                    {onOpen ? (
                      <button
                        type="button"
                        onClick={() => onOpen(e)}
                        className="min-w-0 flex-1 flex items-center gap-3 text-left"
                      >
                        <PodcastCover
                          image={e.image}
                          artwork={e.feedImage}
                          title={showTitle(e)}
                          seed={String(e.feedId)}
                          className="w-12 h-12 flex-shrink-0"
                        />
                        <span className="min-w-0 flex-1 block">
                          <span className="block text-sm font-display leading-tight truncate">{e.title}</span>
                          <span className="block text-[11px] text-muted truncate">{metaLine(e)}</span>
                        </span>
                      </button>
                    ) : (
                      <>
                        <PodcastCover
                          image={e.image}
                          artwork={e.feedImage}
                          title={showTitle(e)}
                          seed={String(e.feedId)}
                          className="w-12 h-12 flex-shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-display leading-tight truncate">{e.title}</div>
                          <div className="text-[11px] text-muted truncate">{metaLine(e)}</div>
                        </div>
                      </>
                    )}
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
                    {/* ✕ removes this row and nothing else — `dismissRow`.
                        Last in the row, after QUEUE, so a thumb reaching for
                        QUEUE does not land on it. 36px square: past WCAG
                        2.5.8's 24px floor, and the title keeps the width. The
                        label names the episode, because a screen reader hears
                        every row's ✕ out of context. */}
                    <button
                      type="button"
                      onClick={() => dismissRow(e)}
                      className="btn-ghost w-9 h-9 p-0 flex-shrink-0 inline-flex items-center justify-center"
                      title="Remove from new episodes"
                      aria-label={`Remove ${e.title} from new episodes`}
                    >
                      <span aria-hidden>✕</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {/* CLEAR sits beside SHOW MORE and only while there is a list. It
                is the reader's half of the bargain the persisted list makes:
                rows now stay until somebody says otherwise, so somebody needs a
                way to say it. Both are plain `.btn-ghost`s at one size, which
                is the cluster rule the favorites controls already follow. */}
            {rows.length > 0 && (
              <div className="flex gap-2 mt-2">
                {rows.length > shown && (
                  <button
                    type="button"
                    onClick={() => setShown((n) => n + PAGE)}
                    className="btn-ghost flex-1 text-xs"
                  >
                    SHOW MORE ({rows.length - shown})
                  </button>
                )}
                <button
                  type="button"
                  onClick={clearRows}
                  className={`btn-ghost text-xs ${rows.length > shown ? '' : 'w-full'}`}
                >
                  CLEAR
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
