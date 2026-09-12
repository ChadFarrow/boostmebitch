'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { loadEpisodeFromFeed } from '@/lib/podcast-meta';
import {
  advanceMarks, pruneMarks, selectNewEpisodes, sinceForBatch,
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
/** One request's worth of feeds; the route caps at the same number. */
const MAX_FEEDS = 100;
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

  const check = useCallback(async (force: boolean) => {
    if (running.current) return;
    const stored = storage.newEpisodeMarks.get(npub);
    setRecord(stored);

    const feeds = Object.values(favorites)
      // `id` is 0 until this device resolves one — the same filter
      // `<LivePage>`'s `favIdList` makes, and for the same reason: a feed with
      // no PI id cannot be asked about.
      .filter((f) => f.id > 0)
      .slice(0, MAX_FEEDS);
    if (!feeds.length) { setPhase('done'); return; }

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
      setUncovered(feeds.length - covered.length);

      // The marks advance on EVIDENCE only — a feed that was not covered, a
      // covered feed with no rows, and a truncated pass all leave theirs
      // alone. That rule is `advanceMarks`, pinned by `check:favnew`.
      const coveredGuids = covered.map((id) => guidByFeedId[id]).filter(Boolean);
      const nextMarks = pruneMarks(
        advanceMarks(stored.marks, episodes, coveredGuids, guidByFeedId, truncated),
        Object.keys(favorites),
      );
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
      setPhase('failed');
    } finally {
      running.current = false;
    }
  }, [favorites, npub]);

  useEffect(() => {
    if (!mounted) return;
    void check(false);
  }, [mounted, check]);

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

      {!isCollapsed && (
        <div id="fav-new-list">
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

          {/* NOT "nothing new" — this names how many shows went unasked. The
              two are different claims and only one of them is true here. */}
          {phase === 'done' && uncovered > 0 && (
            <p className="text-muted text-sm py-3">
              Could not check {uncovered} of your shows.{' '}
              <button type="button" onClick={() => void check(true)} className="underline">
                try again
              </button>
            </p>
          )}

          {phase === 'done' && rows.length === 0 && uncovered === 0 && (
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
            <>
              <ul className="space-y-2">
                {rows.slice(0, shown).map((e) => (
                  <li key={`${e.feedId}:${e.guid ?? e.id}`} className="card flex items-center gap-3 p-3">
                    <PodcastCover
                      image={e.image || e.feedImage}
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
                        own queue control does. */}
                    <NoteQueueButton
                      episode={e}
                      onQueue={async () => {
                        const loaded = await loadEpisodeFromFeed(e.feedId, e.guid ?? '');
                        if (!loaded?.episode) return false;
                        return useApp.getState().enqueueEpisode(loaded.episode, loaded.podcast);
                      }}
                    />
                  </li>
                ))}
              </ul>
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
      )}
    </section>
  );
}
