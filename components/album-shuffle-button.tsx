'use client';

import type { Episode, Podcast } from '@/lib/types';
import { useApp } from '@/lib/store';
import { albumShuffleTracks, isShuffleableTrack } from '@/lib/util';

/**
 * ⤮ SHUFFLE on an album (docs/ui.md, "The album shuffle"). It plays every
 * track of the album in a random order, through the favorites shuffle's list:
 * `startShuffle`, the ⏮/⏭ that list owns, and the "Shuffle · N tracks" panel
 * on the now-playing screen.
 *
 * **The first track starts inside the press.** The rows are already on the
 * page, so nothing is awaited between the tap and `startShuffle` — iOS ties
 * `play()` to the gesture.
 *
 * **A press is a new shuffle, never a toggle.** Each press deals a new order,
 * as the favorites button does; the album plays in order again from the
 * cover's ▶ or a row tap, which end the shuffle (`play()`).
 *
 * Albums only, at two playable tracks or more — `<EpisodeList>` gates the
 * first, this the second. `albumShuffleTracks` says why not a playlist.
 */
export function AlbumShuffleButton({ episodes, podcast }: { episodes: Episode[]; podcast: Podcast }) {
  const count = episodes.filter(isShuffleableTrack).length;
  if (count < 2) return null;

  function press() {
    const app = useApp.getState();
    app.startShuffle(albumShuffleTracks(episodes, podcast, app.current));
  }

  return (
    <button
      type="button"
      data-album-shuffle
      onClick={press}
      // `.btn-mini` for the row's 27px height, with BONE text: its own muted
      // text read as disabled on a real iPhone (the favorites shuffle's lesson).
      className="btn-mini border-bone/60 text-bone"
    >
      <span aria-hidden>⤮</span> SHUFFLE
      <span className="sr-only"> the {count} tracks of this album</span>
    </button>
  );
}
