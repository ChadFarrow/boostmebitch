'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useApp } from '@/lib/store';
import type { Episode, ValueTimeSplit } from '@/lib/types';
import { inMusicHold, musicHoldLeadSec, musicHoldSpans } from '@/lib/util';

/**
 * Keeps the store's `musicHold` true while the position is inside a song of the
 * episode, so <Player> plays that stretch at 1× whatever speed the listener set.
 * The rule is `musicHoldSpans` (lib/util.ts); this is its wiring. Returns the sync
 * <Player> calls from both `timeupdate` handlers and from `seeked`.
 *
 * **It reads the raw `currentTime`, from before the whole-second gate.** The store's
 * `positionSec` ticks once a second, which at 2× is half a second of a song at the
 * wrong speed, and selecting it would re-render <Player> on every tick. The flag is
 * written only when it changes.
 *
 * **Everything that moves the playhead goes through `timeupdate` or `seeked`**: a
 * skip, a scrub, a chapter jump, a resume, a `?t=` link and the lock screen all land
 * on the right speed with no wiring of their own. A paused element fires `seeked` too.
 *
 * **The resolved list when there is one, else the markers on the episode.** The
 * resolved one carries each track's real length and its feed's medium. Before it
 * answers, and offline, a marker over the cap holds nothing, so a bad one cannot
 * hold 1× through the talk: the song under it plays at speed until the list arrives.
 *
 * **A raw store subscription for a move of `current`**, for `useShowSpeed`'s reason:
 * the listener runs inside the `set()`, so the first render with the new source
 * already has the right speed. Subscribe before the reveal effect sets `current`.
 * Skipped for a refresh of the same item in place, which would otherwise answer from
 * the raw markers and drop a song held by the resolved list until the next tick.
 */
export function useMusicHold(
  episode: Episode | undefined,
  resolved: ValueTimeSplit[] | null,
): (positionSec: number) => void {
  const raw = episode?.valueTimeSplits;
  const live = episode?.liveStatus === 'live' || episode?.liveStatus === 'pending';
  const spans = useMemo(
    () => (live ? [] : musicHoldSpans(resolved?.length ? resolved : raw)),
    [live, raw, resolved],
  );
  const spansRef = useRef(spans);
  spansRef.current = spans;

  useEffect(() => useApp.subscribe((s, prev) => {
    if (s.current === prev.current) return;
    const ep = s.current?.episode;
    const was = prev.current?.episode;
    if (ep && was && ep.id === was.id && ep.enclosureUrl === was.enclosureUrl) return;
    const onLive = ep?.liveStatus === 'live' || ep?.liveStatus === 'pending';
    const hold = !!ep && !onLive && inMusicHold(
      musicHoldSpans(ep.valueTimeSplits),
      s.positionSec,
      musicHoldLeadSec(s.playbackRate),
    );
    if (hold !== s.musicHold) useApp.setState({ musicHold: hold });
  }), []);

  return useCallback((positionSec: number) => {
    const s = useApp.getState();
    const hold = inMusicHold(spansRef.current, positionSec, musicHoldLeadSec(s.playbackRate));
    if (hold !== s.musicHold) useApp.setState({ musicHold: hold });
  }, []);
}
