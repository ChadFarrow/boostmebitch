'use client';

import { useEffect } from 'react';
import { useApp } from '@/lib/store';
import { canResume } from '@/lib/resume-position';
import { epKey, listenStep, PLAY_HISTORY_LISTEN_SEC } from '@/lib/util';

/**
 * Puts the playing episode into the Listen tab's HISTORY once it has been
 * LISTENED to for a minute — so somebody who queued several episodes, heard a
 * few and watched the queue drain each one can go back and boost them.
 *
 * **A minute of listening, not a minute of position.** Each store tick adds
 * `listenStep(prev, next)`: ~1 s at 1×, ~5 s at 5×, and nothing for a seek, a
 * scrub or a rewind. So an episode resumed at 40:00 and sampled for ten
 * seconds stays out, and one played from 0:00 goes in at 1:00.
 *
 * **Podcast episodes only**, on `canResume`'s test: not music (an album would
 * fill the history track by track), not live, not HLS. Asked once, at the
 * moment of recording, against the pair the store holds then.
 *
 * **Once per visit to an episode.** The counter resets when `current` moves to
 * another episode, so coming back to one later and listening again moves it to
 * the top of the history with the new time (`addToHistory`).
 *
 * A raw store subscription for `useResumePosition`'s reason: `positionSec`
 * changes every second, and selecting it would re-render all of `<Player>`.
 * The episode is told apart by `epKey`, the history's own key, so a value
 * refresh that replaces `current.episode` in place does not reset the count.
 */
export function usePlayHistory(): void {
  useEffect(() => {
    let counted = 0;
    let recorded = false;

    return useApp.subscribe((s, prev) => {
      const key = s.current ? epKey(s.current.episode) : null;
      const prevKey = prev.current ? epKey(prev.current.episode) : null;
      if (key !== prevKey) {
        counted = 0;
        recorded = false;
        return;
      }
      // Both ticks playing: a position that moved while paused is a scrub.
      if (recorded || !s.current || !s.isPlaying || !prev.isPlaying) return;
      if (s.positionSec === prev.positionSec) return;
      counted += listenStep(prev.positionSec, s.positionSec);
      if (counted < PLAY_HISTORY_LISTEN_SEC) return;
      recorded = true;
      const { episode, podcast } = s.current;
      if (canResume(episode, podcast)) s.recordListen(episode, podcast);
    });
  }, []);
}
