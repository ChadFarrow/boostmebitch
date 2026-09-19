'use client';

// The "+ queue" control on a Nostr note's episode card.
//
// WHY THIS IS NOT <QueueButton>. That one takes an episode it can queue
// immediately. Here the episode on the card is Podcast Index's indexed record,
// which carries no value block, so queueing it would put an item in Up Next
// that plays and pays nobody. The real episode has to come out of `/api/feed`
// first, which makes this control ASYNC — and an async control needs a busy
// state and a failure state that a synchronous one does not. Folding the two
// together would mean giving every list row a spinner it can never show.
//
// What the two DO share is the queued-state read, and it is deliberately the
// same expression: `epKey` prefers the item guid, and the PI record and the
// feed record carry the same one, so the ✓ here survives the round trip and a
// remount without this component tracking anything of its own.

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { epKey, LISTEN_QUEUE_CAP } from '@/lib/util';
import type { Episode } from '@/lib/types';

type State = 'idle' | 'busy' | 'failed';

export function NoteQueueButton({
  episode,
  onQueue,
}: {
  /** PI's record — used for its IDENTITY only. `onQueue` resolves the real one. */
  episode: Episode;
  onQueue: () => Promise<boolean>;
}) {
  const key = epKey(episode);
  // A boolean, never the array: <NoteCard> is memoized and a feed renders
  // hundreds of them, so selecting `listenQueue` itself would re-render every
  // card on every press.
  const queued = useApp((s) => s.listenQueue.some((i) => epKey(i.episode) === key));
  const full = useApp((s) => s.listenQueue.length >= LISTEN_QUEUE_CAP);
  const removeFromQueue = useApp((s) => s.removeFromQueue);
  const [state, setState] = useState<State>('idle');

  const atCap = full && !queued;

  async function onClick(e: React.MouseEvent) {
    // The card body around this is a tap target that navigates.
    e.stopPropagation();
    e.preventDefault();
    if (queued) { removeFromQueue(key); return; }
    if (state === 'busy') return;
    setState('busy');
    // A network failure here has to be VISIBLE. The alternative is a button
    // that was pressed, did nothing, and said nothing — indistinguishable from
    // a dead control, which is the failure this repo keeps paying for.
    try {
      setState(await onQueue() ? 'idle' : 'failed');
    } catch {
      setState('failed');
    }
  }

  const label = queued ? '✓' : state === 'busy' ? '…' : state === 'failed' ? '↻' : '＋';
  const word = state === 'failed' && !queued ? 'RETRY' : 'QUEUE';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={atCap || state === 'busy'}
      aria-pressed={queued}
      aria-busy={state === 'busy'}
      aria-label={queued ? `Remove ${episode.title} from the queue` : `Add ${episode.title} to the queue`}
      title={
        atCap ? `The queue is full (${LISTEN_QUEUE_CAP})`
          : state === 'failed' ? 'Could not load this episode — press to try again'
          : queued ? 'Remove from Up Next'
          : 'Play after what is queued'
      }
      className={`inline-flex items-center justify-center font-mono uppercase tracking-wider border transition active:translate-y-px flex-shrink-0 gap-1.5 px-2.5 py-2 text-sm sm:gap-2 sm:px-4 ${
        queued
          ? 'border-bolt text-bolt hover:bg-bolt/10'
          : 'border-bone/40 text-bone/70 hover:border-bolt/70 hover:text-bolt'
      } ${atCap || state === 'busy' ? 'opacity-50' : ''}`}
    >
      {/* Fixed-width glyph box, same reason as the heart's: these four glyphs
          are different widths in the fallback font, and this control sits next
          to one whose whole note is about not moving when pressed. */}
      <span className="inline-block w-[0.9em] text-center text-lg leading-none">{label}</span>
      {/* `size="md"`'s rule: this card's controls keep their word at every
          width, because a bare glyph is the whole action here. */}
      <span>{word}</span>
    </button>
  );
}
