'use client';

import { useEffect } from 'react';
import { resolvePlaybackRate, speedKeyFor, useApp } from '@/lib/store';

/**
 * Puts the speed of the show now in the player into the store: its own speed
 * (`bmb:playback_rate:<showKey>`) when it has one, else the global speed. The
 * WRITE is `setPlaybackRate`'s; this is the read that follows `current`.
 *
 * Re-resolved only when the show changes — told apart by `speedKeyFor`, which
 * is null for a track feed, an HLS enclosure and a live item — so a value
 * refresh that replaces `current.episode` in place, or the next episode of the
 * same show, leaves the speed alone.
 *
 * **A raw store subscription, not an effect on `current`.** The listener runs
 * inside the `set()` that moved `current`, so the first render with the new
 * source already holds the new speed, and the apply effect in `<Player>` sets
 * it on the element in the same pass that re-sources it. An effect would apply
 * the OLD show's speed to the new source first. One listener also covers every
 * writer of `current` — `play`, `cue`, `stepTo`, the queue paths and the two
 * reveals.
 */
export function useShowSpeed(): void {
  useEffect(() => useApp.subscribe((s, prev) => {
    if (s.current === prev.current) return;
    const key = speedKeyFor(s.current);
    const prevKey = speedKeyFor(prev.current);
    if (key === prevKey) return;
    const rate = resolvePlaybackRate(s.current);
    if (rate !== s.playbackRate) useApp.setState({ playbackRate: rate });
  }), []);
}
