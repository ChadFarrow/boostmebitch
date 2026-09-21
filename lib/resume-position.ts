'use client';

// Where the listener left each unfinished podcast episode, so pressing play on
// it again starts there instead of at 0:00.
//
// THREE PARTS, ONE MODULE. The store's `play()` and `stepTo` READ it
// (`savedStartSec`) and put the answer in `positionSec`, which is the existing
// start-position path: `<Player>`'s source effect seeks there on
// `loadedmetadata`, and the streaming engine takes its baseline from the same
// number, so a resume is not billed as a forward seek. `useResumePosition`
// (components/player/use-resume-position.ts) WRITES it. The episode rows and
// the episode page SHOW it (`useSavedPosition`).
//
// WHAT RESUMES. Podcast episodes only. A track on a `playsAsTracks` feed starts
// at 0:00, and a live item has no position to go back to — `<Player>` already
// forces those to 0 (`isLiveMedia`), and nothing is saved for them here either,
// so the store's `positionSec` never claims a start the element will not take.
//
// THE TWO THRESHOLDS, and which way each one fails:
//
// - A position under RESUME_MIN_SEC is NOT WRITTEN — and not deleted either.
//   A new source resets `<Player>`'s `lastTick`, so the element's first
//   `timeupdate` reports ~0 BEFORE `loadedmetadata` seeks to the saved point.
//   Recording that 0 would erase the place the listener is being returned to,
//   during the very load that returns them there. The cost of skipping is
//   small: someone who scrubs back to the start and leaves is resumed at their
//   older place.
// - A position within RESUME_TAIL_SEC of the end means FINISHED, and the entry
//   is deleted. Outros and credits are routinely that long, and a resume that
//   lands on ten seconds of music and then ends reads as a broken play button.
//   `ended` clears an entry without any code in `onEnded`: it sets `isPlaying`
//   false, the writer flushes on pause, and the writer sees the element's
//   `ended` flag and calls `forgetPosition` — which does not depend on knowing
//   the duration, so a file with none still clears.
//
// THE KEY prefers the EPISODE's own `podcastGuid` over the podcast it was
// played from. A `podcastL` playlist is a container: its rows are episodes of
// other feeds, and the same episode opened from its own show must find the
// same entry. `||`, not `??`, on both halves, because feeds publish an empty
// `<guid></guid>` and PI mirrors it.
import { useCallback, useSyncExternalStore } from 'react';
import type { Episode, Podcast } from './types';
import { storage, type ResumeEntry } from './storage';
import { createObservable } from './pubsub';
import { isHlsUrl, playsAsTracks } from './util';

export type { ResumeEntry };

/** Below this many seconds a position is not written. See the header. */
export const RESUME_MIN_SEC = 15;
/** Within this many seconds of the end an episode counts as finished. */
export const RESUME_TAIL_SEC = 30;

/**
 * How far BEHIND the saved point the element must be before the player offers
 * to jump back.
 *
 * Not a cosmetic threshold. The writer updates the entry every ten seconds of
 * movement, so while playback runs normally the saved point and the element
 * track each other within that — anything at or under it would make the offer
 * flicker on during ordinary listening. 30 s clears it with room, and is far
 * below the case the offer exists for: an element reset to 0 while storage
 * still holds minutes.
 */
export const RESUME_GAP_SEC = 30;

/**
 * A saved point is not moved BACKWARDS by more than this while the element is
 * still inside {@link RESUME_REWIND_HEAD_SEC} of the start.
 *
 * **This is a data-loss guard, and it was earned.** Reported 2026-09-21 on an
 * iPhone, with the download still present so nothing was evicted: *"I did
 * resume the episode earlier without an issue but the second time I tried
 * minutes later it started over."*
 *
 * iOS drops a backgrounded media element's buffer, and it comes back sitting at
 * 0 while the store and storage still hold 17:04. Nothing re-seeks it, so a
 * press of play runs from the beginning — and fifteen seconds later the writer
 * has replaced 17:04 with 16, then 26. The `RESUME_MIN_SEC` floor is the only
 * reason the FIRST attempt still worked: under 15 s nothing is written at all.
 * That is a fifteen-second window in which an hour of listening is destroyed by
 * doing nothing.
 *
 * THE COST IS STATED AND SMALL: a listener who deliberately restarts an episode
 * gets no resume tracking for the first two minutes, because those writes are
 * refused as if they were this fault. Play past two minutes and the point moves
 * normally. Losing two minutes of tracking is recoverable; losing the hour is
 * what was reported.
 *
 * It is deliberately NOT a "did the user seek?" test. That needs a signal
 * threaded from three call sites through a module none of them import, and the
 * one it would protect — a deliberate restart — is exactly the case the
 * two-minute head already forgives.
 */
const RESUME_REWIND_MAX_SEC = 120;
const RESUME_REWIND_HEAD_SEC = 120;

type ResumeEpisode = Pick<
  Episode,
  'id' | 'guid' | 'feedId' | 'podcastGuid' | 'enclosureUrl' | 'liveStatus' | 'duration'
>;
type ResumePodcast = Pick<Podcast, 'id' | 'podcastGuid' | 'medium'>;

export function resumeKey(episode: ResumeEpisode, podcast: ResumePodcast): string {
  const feed = episode.podcastGuid || podcast.podcastGuid || `feed:${episode.feedId || podcast.id}`;
  return `${feed}::${episode.guid || `id:${episode.id}`}`;
}

/** Whether this item saves and resumes a position at all. */
export function canResume(episode: ResumeEpisode, podcast: ResumePodcast): boolean {
  if (!episode.enclosureUrl) return false;
  if (playsAsTracks(podcast)) return false;
  if (isHlsUrl(episode.enclosureUrl)) return false;
  return episode.liveStatus !== 'live' && episode.liveStatus !== 'pending';
}

function inTail(t: number, d: number): boolean {
  return d > 0 && d - t <= RESUME_TAIL_SEC;
}

// The in-memory copy every reader uses. Loaded once, replaced after each write.
// Entries that did not change keep their object identity (`adopt`), so a write
// every ten seconds re-renders the one row whose entry moved, not every row
// with a label.
let cache: Record<string, ResumeEntry> | null = null;
const changes = createObservable();

function entries(): Record<string, ResumeEntry> {
  if (!cache) cache = storage.resumePositions.get();
  return cache;
}

function adopt(next: Record<string, ResumeEntry>): void {
  const prev = cache ?? {};
  for (const [k, b] of Object.entries(next)) {
    const a = prev[k];
    if (a && a.t === b.t && a.d === b.d && a.at === b.at) next[k] = a;
  }
  cache = next;
  changes.notify();
}

/** The saved entry, or null when there is none or this item never resumes. */
export function savedEntry(episode: ResumeEpisode, podcast: ResumePodcast): ResumeEntry | null {
  if (!canResume(episode, podcast)) return null;
  const e = entries()[resumeKey(episode, podcast)];
  if (!e || inTail(e.t, e.d || episode.duration || 0)) return null;
  return e;
}

/** Where `play()` should start this item: the saved point, or 0. */
export function savedStartSec(episode: ResumeEpisode, podcast: ResumePodcast): number {
  return savedEntry(episode, podcast)?.t ?? 0;
}

/**
 * Record that `episode` is at `t` seconds of `duration`. Applies both
 * thresholds (see the header). `duration` is the media element's when it is
 * finite, else the feed's.
 */
export function recordPosition(
  episode: ResumeEpisode,
  podcast: ResumePodcast,
  t: number,
  duration: number | undefined,
): void {
  if (typeof window === 'undefined') return;
  if (!canResume(episode, podcast)) return;
  if (!Number.isFinite(t) || t < RESUME_MIN_SEC) return;
  // An element reporting an infinite duration is a stream that nothing tagged
  // as live. There is no place in it to come back to.
  if (duration === Infinity) return;
  const d = duration !== undefined && Number.isFinite(duration) && duration > 0
    ? duration
    : (episode.duration || 0);
  if (inTail(t, d)) {
    forgetPosition(episode, podcast);
    return;
  }
  const key = resumeKey(episode, podcast);
  // REFUSE A LARGE REWIND FROM THE HEAD OF THE FILE. See
  // RESUME_REWIND_MAX_SEC: an element that lost its buffer comes back at 0 and
  // would otherwise erase a point minutes in, a second at a time, while the
  // listener watches it play from the start. Both bounds are needed — the jump
  // has to be large AND the new position has to be near the beginning, or a
  // normal scrub backwards mid-episode would be refused too.
  const prev = entries()[key];
  if (prev && t < RESUME_REWIND_HEAD_SEC && prev.t - t > RESUME_REWIND_MAX_SEC) return;
  write(key, { t, d, at: Date.now() });
}

/** The episode was finished: drop its entry, whatever the position says. */
export function forgetPosition(episode: ResumeEpisode, podcast: ResumePodcast): void {
  if (typeof window === 'undefined') return;
  write(resumeKey(episode, podcast), null);
}

function write(key: string, value: ResumeEntry | null): void {
  // Re-read rather than trust the cache: a second tab may have written since.
  const map = storage.resumePositions.get();
  if (value) {
    map[key] = value;
  } else {
    if (!(key in map)) return;
    delete map[key];
  }
  storage.resumePositions.set(map);
  // Read back what was kept: `set` applies the cap.
  adopt(storage.resumePositions.get());
}

/** The saved entry for a row or page, re-rendering when it changes. Takes
 *  null so a page can call it above its own "nothing selected" return. */
export function useSavedPosition(
  episode: ResumeEpisode | null | undefined,
  podcast: ResumePodcast | null | undefined,
): ResumeEntry | null {
  const getSnapshot = useCallback(
    () => (episode && podcast ? savedEntry(episode, podcast) : null),
    [episode, podcast],
  );
  return useSyncExternalStore(changes.subscribe, getSnapshot, serverSnapshot);
}

function serverSnapshot(): null {
  return null;
}
