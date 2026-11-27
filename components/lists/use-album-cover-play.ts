'use client';

import { useCallback, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { loadFeed } from '@/lib/podcast-meta';
import { albumHoldsCurrent, firstPlayableTrack, isMusicMedium, sameCurrentTrack } from '@/lib/util';
import type { Podcast } from '@/lib/types';
import type { CoverPlay } from './podcast-results';

type Press = { key: string; state: 'loading' | 'failed' };

const albumKey = (p: Pick<Podcast, 'id' | 'podcastGuid'>) => p.podcastGuid || String(p.id);

/**
 * A press on an album's cover in a LIST of albums plays the album — `/demu`
 * (Chad, 2026-11-16: "if I click the artwork could it just play it?"). Returns
 * the per-row `coverPlay` for `<PodcastResults>`, or null for a row that is not
 * an album, whose cover stays inside the row and opens it as before.
 *
 * It plays the album without the album page. It is NOT the album page's
 * header ▶, which always starts the album over since 2026-11-22 (Chad:
 * "album-over: yes"; `coverStartSeeks`). In a grid of albums ❚❚ marks the one
 * playing, so this cover keeps its pause:
 * - **A press on the album that holds the player pauses or resumes it**
 *   (`albumHoldsCurrent`). Anything that draws ❚❚ must pause; a `play()` over
 *   the current item is a silent no-op (docs/ui.md).
 * - **Otherwise it loads the album and starts its first track**
 *   (`firstPlayableTrack`) in the feed's order, which is the album page's
 *   default order.
 * - **It writes `episodeQueue` itself.** On the album page `<EpisodeList>` does
 *   that from its rows, and ⏭ and a track's end walk it; `/demu` mounts no
 *   `<EpisodeList>`, and a queue left from the last album opened would give
 *   `stepTo` no row to step from, so the album would stop after one track.
 *
 * **Only the last press starts anything** (`gen`), and a press is dropped when
 * the player moved to another track while the feed loaded — the favorites
 * shuffle's rule (`sameCurrentTrack`, by `epKey`, never by object).
 *
 * **iOS may need a second press on a cold start.** iOS ties `play()` to the
 * gesture, and the feed request is an `await` over real I/O, so the first
 * `play()` of a page session can be refused. `<Player>` then parks the track
 * (`playOrPark`), the badge turns to a filled ▶, and the second press resumes
 * it inside its own gesture through `togglePlay`. The favorites shuffle has the
 * same fallback. Not driven on an iPhone.
 */
export function useAlbumCoverPlay(): (p: Podcast) => CoverPlay | null {
  const current = useApp((s) => s.current);
  const isPlaying = useApp((s) => s.isPlaying);
  const shuffle = useApp((s) => s.shuffle);
  const listenQueue = useApp((s) => s.listenQueue);
  const [press, setPress] = useState<Press | null>(null);
  const gen = useRef(0);

  const start = useCallback(async (p: Podcast) => {
    const app = useApp.getState();
    if (albumHoldsCurrent(p, app.current, app.shuffle?.items ?? null, app.listenQueue)) {
      // A newer press: an album still loading from an earlier one must not
      // start over this pause.
      gen.current++;
      setPress(null);
      app.togglePlay();
      return;
    }
    const my = ++gen.current;
    const key = albumKey(p);
    const before = app.current;
    setPress({ key, state: 'loading' });
    try {
      // `loadFeed`, the one place the browser asks `/api/feed`: it coalesces a
      // request in flight, so opening the album right after the press costs no
      // second download.
      const d = await loadFeed(p.isPreview && p.url ? { feedUrl: p.url } : { feedId: p.id });
      if (my !== gen.current) return;
      const episodes = Array.isArray(d?.episodes) ? d.episodes : [];
      const first = firstPlayableTrack(episodes);
      // An `{ error }` body parses fine: no podcast, or no track to start, is a
      // failed press — said on the badge, never a press that silently did nothing.
      if (!d?.podcast || !first) { setPress({ key, state: 'failed' }); return; }
      setPress(null);
      const now = useApp.getState();
      if (!sameCurrentTrack(before, now.current)) return;
      now.setEpisodeQueue(episodes, d.podcast);
      // The feed's own podcast record, never the list row: only an RSS document
      // names a payee, and this is the record the album page plays with.
      now.play(first, d.podcast);
    } catch {
      if (my === gen.current) setPress({ key, state: 'failed' });
    }
  }, []);

  return (p) => {
    // An album only. A musicL playlist plays tracks from OTHER feeds, through
    // the playlist pager, and `/api/feed` does not list them.
    if (!isMusicMedium(p)) return null;
    const pressed = press?.key === albumKey(p) ? press.state : null;
    const holds = albumHoldsCurrent(p, current, shuffle?.items ?? null, listenQueue);
    const state: CoverPlay['state'] =
      pressed === 'loading' ? 'loading'
      : holds ? (isPlaying ? 'playing' : 'paused')
      : pressed === 'failed' ? 'failed'
      : 'idle';
    return { state, onPress: () => void start(p) };
  };
}
