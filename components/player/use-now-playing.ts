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
 * back to, and the previous record is left standing instead. A REFRESH of a
 * live item is the exception, kept per tab: when the page hides, the live item's
 * feed id and guid, whether it played and whether the full-screen player was
 * open go to `bmb:live_refresh` (sessionStorage), and `<Player>` picks it back
 * up from its feed (docs/ui.md, "A refresh picks a live stream back up").
 *
 * A raw store subscription for `usePlayHistory`'s reason: selecting would
 * re-render all of `<Player>` on every tick.
 */
export function useNowPlaying(): void {
  // On `pagehide`, and on `visibilitychange` to hidden because a phone may
  // discard a hidden tab without a `pagehide`. Anything but a live item clears
  // the record, so a refresh never brings back a show the listener left.
  useEffect(() => {
    const save = () => {
      const { current, isPlaying, playerExpanded } = useApp.getState();
      const feedId = current?.podcast.id ?? current?.episode.feedId;
      if (current?.episode.liveStatus === 'live' && current.episode.guid && feedId) {
        storage.liveRefresh.set({ feedId, guid: current.episode.guid, playing: isPlaying, expanded: playerExpanded, at: Date.now() });
      } else {
        storage.liveRefresh.clear();
      }
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') save(); };
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

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
