'use client';

import { useEffect, type RefObject } from 'react';
import { useApp } from '@/lib/store';
import { forgetPosition, recordPosition } from '@/lib/resume-position';
import type { Episode, Podcast } from '@/lib/types';

/** While playing, write again once the position has moved this far. */
const WRITE_EVERY_SEC = 10;

interface Args {
  audio: RefObject<HTMLAudioElement | null>;
  video: RefObject<HTMLVideoElement | null>;
  /** Whether the video element is the active one. */
  isVideoRef: RefObject<boolean>;
  /** True while a downloaded source is resolving — the element's clock is
   *  the PREVIOUS episode's, so no position may be written. */
  pendingLocalSrc: RefObject<boolean>;
}

type Item = { episode: Episode; podcast: Podcast };

/**
 * Writes where the listener is in the current episode, so the next `play()` of
 * it resumes there. The rules — what saves, what counts as finished, why a
 * position under 15 s is never written — are in lib/resume-position.ts.
 *
 * **A raw store subscription, not a selector.** `positionSec` changes every
 * second; selecting it here would re-render all of `<Player>` on each tick,
 * which is what its per-field selectors exist to prevent. The streaming engine
 * stays off the render path for the same reason.
 *
 * **The outgoing episode is flushed from `prev`.** `play()` replaces `current`
 * and `positionSec` in ONE update, so by the time anything re-renders, the old
 * episode's position is gone from the store. The listener runs synchronously
 * inside that `set()`, before `<Player>`'s source effect repoints the element,
 * so `prev.positionSec` is the old episode's last second and the element's
 * `duration` is still the old file's.
 *
 * Writes happen on: an episode change, a pause (which includes `ended` — the
 * element's `ended` flag then deletes the entry), every
 * WRITE_EVERY_SEC of movement (a scrub included), and the page going hidden.
 * `visibilitychange` as well as `pagehide`, because iOS kills a backgrounded
 * home-screen app without firing `pagehide`.
 */
export function useResumePosition({ audio, video, isVideoRef, pendingLocalSrc }: Args): void {
  useEffect(() => {
    const media = () => (isVideoRef.current ? video.current : audio.current);
    let lastWritten = NaN;

    // An element that reached its end means the episode was finished, even
    // when no duration was ever known to put `t` in the finished tail.
    const write = (item: Item, t: number) => {
      const el = media();
      if (el?.ended) forgetPosition(item.episode, item.podcast);
      else recordPosition(item.episode, item.podcast, t, el?.duration);
      lastWritten = t;
    };

    const unsubscribe = useApp.subscribe((s, prev) => {
      if (s.current?.episode.id !== prev.current?.episode.id) {
        if (prev.current) write(prev.current, prev.positionSec);
        // The new episode's start IS its saved point; nothing to write yet.
        lastWritten = s.positionSec;
        return;
      }
      if (!s.current) return;
      if (prev.isPlaying && !s.isPlaying) {
        write(s.current, s.positionSec);
        return;
      }
      if (s.positionSec !== prev.positionSec
        && !(Math.abs(s.positionSec - lastWritten) < WRITE_EVERY_SEC)) {
        write(s.current, s.positionSec);
      }
    });

    // The element's own clock is fresher than the 1 Hz store copy. It reads 0
    // while a new source loads, which the 15 s floor ignores; fall back to the
    // store's value then.
    const flushNow = () => {
      if (pendingLocalSrc.current) return;
      const s = useApp.getState();
      if (!s.current) return;
      const t = media()?.currentTime;
      write(s.current, t !== undefined && Number.isFinite(t) && t > 0 ? t : s.positionSec);
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushNow(); };
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      unsubscribe();
      window.removeEventListener('pagehide', flushNow);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [audio, video, isVideoRef, pendingLocalSrc]);
}
