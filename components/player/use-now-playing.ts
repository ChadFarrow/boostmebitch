'use client';

import { useEffect } from 'react';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { epKey, trimForQueue } from '@/lib/util';

/**
 * Remembers which episode is in the player (`bmb:now_playing`), so the next
 * load reopens IT through `revealNowPlaying` rather than the listen queue's
 * head. Reported from the phone: *"When I return to my app it picks back up on
 * the top item in my queue and not what I was last listening to."*
 *
 * Written when `current` moves to another episode, told apart by `epKey`, so
 * a value refresh that replaces `current.episode` in place writes nothing. The
 * PLACE inside the episode is `useResumePosition`'s job, not this one's.
 *
 * **A live item is not written**: a broadcast that ended is nothing to come
 * back to, and the previous record is left standing instead.
 *
 * A raw store subscription for `usePlayHistory`'s reason: selecting would
 * re-render all of `<Player>` on every tick.
 */
export function useNowPlaying(): void {
  useEffect(() => useApp.subscribe((s, prev) => {
    if (!s.current) return;
    const key = epKey(s.current.episode);
    if (prev.current && epKey(prev.current.episode) === key) return;
    const { episode, podcast } = s.current;
    if (episode.liveStatus) return;
    if (!storage.nowPlaying.set({ episode: trimForQueue(episode), podcast })) {
      console.warn('[player] the now-playing episode did not reach disk — a reload will not reopen it.');
    }
  }), []);
}
