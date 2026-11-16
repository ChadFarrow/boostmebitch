'use client';

import { useEffect, useRef, useState } from 'react';
import type { Episode, Podcast } from '@/lib/types';
import { useApp } from '@/lib/store';
import { loadPlaylistPage } from '@/lib/podcast-meta';
import { isShuffleableTrack, listKey, playlistShuffleTracks } from '@/lib/util';

/**
 * Time between two pages the shuffle loads after the press. `/api/playlist` is
 * limited to 30 requests a minute per IP, and the page itself spends some of
 * them (its own next page, the track counts on /playlists); 3 s keeps the
 * shuffle at 20 a minute, under the limit with room for the page.
 */
const SHUFFLE_PAGE_GAP_MS = 3_000;

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading'; have: number; total: number }
  | { kind: 'stopped'; have: number; total: number };

/**
 * ⤮ SHUFFLE on a playlist (docs/ui.md, "The playlist shuffle and repeat").
 *
 * **The tracks already on the page start inside the press**, as the album
 * shuffle's do (iOS ties `play()` to the gesture). A playlist is paged by fetch,
 * so the rest are loaded AFTER the press, one page every SHUFFLE_PAGE_GAP_MS,
 * and each page joins the shuffle at random places after the track playing
 * (`extendShuffle`). The loads stop when the shuffle is replaced or ended — the
 * store's shuffle id is the test — and when a page fails, which the line under
 * the buttons says, with how many tracks the shuffle holds.
 *
 * **Each track is the pair a row tap plays** (`playlistShuffleTracks`), so it
 * pays what the same row tapped pays.
 */
export function PlaylistShuffleButton({
  episodes,
  playlist,
  feedUrl,
  nextOffset,
  total,
}: {
  /** The rows loaded so far, in display order. */
  episodes: Episode[];
  playlist: Podcast;
  feedUrl: string;
  /** The server's next page, used verbatim; null when every page is loaded. */
  nextOffset: number | null;
  /** Distinct tracks in the whole playlist, as the server counts them. */
  total: number;
}) {
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  // Bumped on each press and on unmount, so a loop left from an earlier press
  // or a page that closed stops writing.
  const run = useRef(0);
  useEffect(() => () => { run.current++; }, []);

  const count = episodes.filter(isShuffleableTrack).length;
  if (count < 2 && nextOffset == null) return null;

  function press() {
    const app = useApp.getState();
    const id = app.startShuffle(playlistShuffleTracks(episodes, playlist, app.current), listKey(playlist));
    if (id === null || nextOffset == null) { setState({ kind: 'idle' }); return; }
    const mine = ++run.current;
    void loadRest(id, mine, nextOffset);
  }

  async function loadRest(id: number, mine: number, from: number) {
    const live = () => run.current === mine && useApp.getState().shuffle?.id === id;
    const have = () => useApp.getState().shuffle?.items.length ?? 0;
    let offset: number | null = from;
    setState({ kind: 'loading', have: have(), total });
    while (offset != null) {
      await new Promise((r) => setTimeout(r, SHUFFLE_PAGE_GAP_MS));
      if (!live()) return;
      let page;
      try {
        page = await loadPlaylistPage({ feedUrl, offset });
      } catch {
        page = null;
      }
      if (!live()) return;
      // No `podcast` is how a refused page (a 429, a 5xx) arrives: the route
      // answers `{ error }`. Say so rather than stop in silence.
      if (!page?.podcast || !Array.isArray(page.episodes)) {
        setState({ kind: 'stopped', have: have(), total });
        return;
      }
      const tracks = playlistShuffleTracks(page.episodes, playlist, null);
      useApp.getState().extendShuffle(id, tracks);
      offset = page.nextOffset ?? null;
      setState({ kind: 'loading', have: have(), total });
    }
    if (live()) setState({ kind: 'idle' });
  }

  return (
    <>
      <button
        type="button"
        data-playlist-shuffle
        onClick={press}
        // The album button's look: `.btn-mini` for the row's 27px, BONE text,
        // because the muted text read as disabled on a real iPhone.
        className="btn-mini border-bone/60 text-bone"
      >
        <span aria-hidden>⤮</span> SHUFFLE
        <span className="sr-only"> the tracks of this playlist</span>
      </button>
      {state.kind !== 'idle' && (
        <p className="text-muted text-xs basis-full" role="status" data-playlist-shuffle-status>
          {state.kind === 'loading'
            ? `Adding tracks to the shuffle: ${state.have.toLocaleString()} of ${state.total.toLocaleString()}.`
            : `The shuffle has ${state.have.toLocaleString()} of ${state.total.toLocaleString()} tracks. The rest did not load.`}
        </p>
      )}
    </>
  );
}

/**
 * ↻ REPEAT on a playlist (docs/ui.md, "The playlist shuffle and repeat"): a
 * toggle that names THIS playlist in the store's `repeatList`. While it is on,
 * the playlist plays on from its first track after its last — in order, or in a
 * shuffle this page started — and ⏭ on the last track does the same. In order,
 * the wrap waits until every page is loaded (`episodeQueueComplete`), because
 * a prefix's last row is not the playlist's last track.
 */
export function PlaylistRepeatButton({ playlist }: { playlist: Podcast }) {
  const key = listKey(playlist);
  const on = useApp((s) => s.repeatList === key);
  const setRepeatList = useApp((s) => s.setRepeatList);
  return (
    <button
      type="button"
      data-playlist-repeat
      aria-pressed={on}
      onClick={() => setRepeatList(on ? null : key)}
      className={`btn-mini ${on ? 'border-bolt text-bolt' : 'border-bone/60 text-bone'}`}
      title={on ? 'Stop repeating this playlist' : 'Repeat this playlist'}
    >
      <span aria-hidden>↻</span> REPEAT{on ? ' ON' : ''}
    </button>
  );
}
