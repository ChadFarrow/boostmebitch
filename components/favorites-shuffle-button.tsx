'use client';

import { useState } from 'react';
import type { FavoriteEpisode } from '@/lib/types';
import { useApp } from '@/lib/store';
import { sameCurrentTrack, shuffleOrder } from '@/lib/util';
import { loadPendingShuffleTracks, readShuffleTracks } from '@/lib/favorites-shuffle';

/**
 * ⤮ SHUFFLE on a section of favorite singles (docs/ui.md, "The favorites
 * shuffle"). It plays every row the section holds — the filtered rows, not the
 * revealed slice — in a random order.
 *
 * It sits ON the heading row, positioned, and is not inside the heading: the
 * heading is a `<button>` (the fold), a button may not contain a button, and
 * `section > button[aria-expanded]` is how e2e:favbuttons finds the headings.
 * `<Section>` gives it a `relative` box.
 */
export function FavoritesShuffleButton({ rows }: { rows: FavoriteEpisode[] }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  function press() {
    if (busy) return;
    const app = useApp.getState();
    const read = readShuffleTracks(rows);
    // NO AWAIT ABOVE THIS LINE. The first track starts inside the press, from
    // the cache, because iOS ties `play()` to the gesture.
    const id = read.tracks.length ? app.startShuffle(shuffleOrder(read.tracks)) : null;
    if (!read.pending.length) {
      setNote(noteFor(id !== null, read.skipped));
      return;
    }
    const before = useApp.getState().current;
    setBusy(true);
    setNote(null);
    void loadPendingShuffleTracks(read.pending).then(({ tracks, skipped }) => {
      const s = useApp.getState();
      let started = id !== null;
      let stale = false;
      if (tracks.length && id !== null) {
        // A no-op if this shuffle has since been replaced or ended.
        s.extendShuffle(id, shuffleOrder(tracks));
      } else if (tracks.length && sameCurrentTrack(s.current, before)) {
        // A cold cache: nothing could start in the press. Start now, unless the
        // listener has picked something else while it loaded — then the press
        // is stale, and taking the player from them would be the surprise.
        // Compared by track, never by object: a payee refresh replaces
        // `current` with no choice made (`sameCurrentTrack`).
        // On iOS this start may need a second ▶; that is the cold case's cost.
        started = s.startShuffle(shuffleOrder(tracks)) !== null;
      } else if (tracks.length) {
        stale = true;
      }
      setBusy(false);
      // `skipped` here includes every pending row that did not load. When
      // nothing started, those are LOOKUPS that failed, not unplayable tracks.
      setNote(stale ? null : noteFor(started, read.skipped + skipped, skipped > 0));
    });
  }

  return (
    <>
      <button
        type="button"
        data-shuffle
        onClick={press}
        disabled={busy}
        // `.btn-ghost`, as the quick buttons: `.btn-mini`'s muted text read as
        // disabled on a real iPhone. 28px tall is the heading row's own height.
        className="btn-ghost absolute right-7 top-3 h-7 whitespace-nowrap px-2 text-[11px] disabled:opacity-60"
      >
        <span aria-hidden>⤮ </span>
        {busy ? 'SHUFFLING…' : 'SHUFFLE'}
        <span className="sr-only"> these {rows.length} singles</span>
      </button>
      {note && (
        <p data-shuffle-note role="status" className="px-1 pb-1 text-xs text-muted">
          {note}
        </p>
      )}
    </>
  );
}

/**
 * The line under the heading. "No playable tracks" is a claim about the LIST,
 * so it is made only when nothing failed to load; a batch that answered 429, or
 * a Podcast Index breaker that sent nothing, is a lookup failure, and calling a
 * 232-track library unplayable over it is the false claim `<EmptyLibrary>`
 * already paid for once.
 */
function noteFor(started: boolean, skipped: number, lookupFailed = false): string | null {
  if (!started && !lookupFailed) return 'No playable tracks in this list.';
  if (skipped > 0) return `${skipped} ${skipped === 1 ? 'track' : 'tracks'} could not be loaded.`;
  return null;
}
