'use client';

// The "+ queue" control, shared by every surface that offers one.
//
// It is one component rather than three inline buttons for the reason the rest
// of this repo's shared widgets exist — a second copy drifts, and the drift
// shows up on a screen nobody was looking at. Here the thing that would drift
// is not styling but the REFUSALS: which rows may not be queued, and what the
// control does when the queue is full.

import { useApp } from '@/lib/store';
import { epKey, isPlayableRow, LISTEN_QUEUE_CAP } from '@/lib/util';
import type { Episode, Podcast } from '@/lib/types';

type Size = 'sm' | 'tile';

// The `'sm'` branch keeps `min-h-[44px] min-w-[44px]` even though its only
// consumer today — the episode row — wraps it in `hidden sm:inline-flex`, so
// the mobile minimum never applies there. It is `<FavHeart>`'s `'sm'` shape
// byte for byte, and the next surface to use this size may well be one that
// shows below `sm:`. Removing it would leave that surface under the 44px floor
// with nothing saying it ever had one.

export function QueueButton({
  episode,
  podcast,
  size = 'sm',
  label,
}: {
  episode: Episode;
  podcast?: Podcast | null;
  size?: Size;
  /** What the aria-label names. Defaults to the episode title. */
  label?: string;
}) {
  const key = epKey(episode);

  // **A BOOLEAN, never the array.** `useApp((s) => s.listenQueue)` returns a
  // fresh reference on every queue mutation, so every mounted row and every
  // memoized <NoteCard> re-renders on each press — two hundred of them in a
  // feed. A boolean compares with Object.is, so only the card whose answer
  // actually flipped re-renders. The same applies to `full`.
  const queued = useApp((s) => s.listenQueue.some((i) => epKey(i.episode) === key));
  const full = useApp((s) => s.listenQueue.length >= LISTEN_QUEUE_CAP);
  const enqueueEpisode = useApp((s) => s.enqueueEpisode);
  const removeFromQueue = useApp((s) => s.removeFromQueue);

  // No podcast means no value block to pay and no show to name on the row, so
  // there is nothing worth queueing — the same "no canonical identifier, no
  // control" refusal <FavEpisodeHeart> makes. A row that cannot play, or a live
  // broadcast, is refused by the store too; withholding the control as well is
  // what stops a button that looks live from doing nothing.
  if (!podcast || !isPlayableRow(episode) || episode.liveStatus) return null;

  const atCap = full && !queued;
  const name = label ?? episode.title;

  const onClick = (e: React.MouseEvent) => {
    // Every host row carries its own onClick, and the episode-detail tile sits
    // inside a grid that does not — stopping both here rather than at three
    // call sites is the point of the shared component.
    e.stopPropagation();
    e.preventDefault();
    if (queued) removeFromQueue(key);
    else enqueueEpisode(episode, podcast);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={atCap}
      aria-pressed={queued}
      aria-label={queued ? `Remove ${name} from the queue` : `Add ${name} to the queue`}
      title={
        atCap
          ? `The queue is full (${LISTEN_QUEUE_CAP})`
          : queued ? 'Remove from Up Next' : 'Play after what is queued'
      }
      className={classes(queued, atCap, size)}
    >
      {/* FIXED-WIDTH GLYPH BOX, for the reason the heart's carries one: ＋ and
          ✓ are different widths in the fallback font, so a bare swap resizes
          the control and shifts the BOOST button beside it on every press. */}
      <span className="inline-block w-[0.9em] text-center text-base leading-none">
        {queued ? '✓' : '＋'}
      </span>
      {/* THE WORD DOES NOT CHANGE WITH STATE — QUEUE, not QUEUE/QUEUED — for
          the same layout reason the heart states: a word that grows by two
          characters on press moves everything to its left.

          It is not hidden below sm: any more. The one surface where that width
          is tight is the episode row, and that row now hides this control
          outright below sm: rather than shrinking it — see the note there. */}
      <span>QUEUE</span>
    </button>
  );
}

// Touch target from min-h/min-w rather than padding, so the desktop chip stays
// slim beside a heart that is ~18px tall in the same rows.
function classes(queued: boolean, atCap: boolean, size: Size) {
  if (size === 'tile') {
    return `tile ${queued ? 'border-bolt text-bolt hover:border-bolt hover:bg-bolt/10' : 'hover:border-bolt/70 hover:text-bolt'} ${
      atCap ? 'opacity-40' : ''
    }`;
  }
  return `inline-flex items-center justify-center font-mono uppercase tracking-wider border transition active:translate-y-px flex-shrink-0 gap-1.5 px-3 text-xs leading-none min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 ${
    queued
      ? 'border-bolt text-bolt hover:bg-bolt/10'
      : 'border-bone/40 text-bone/70 hover:border-bolt/70 hover:text-bolt'
  } ${atCap ? 'opacity-40' : ''}`;
}
