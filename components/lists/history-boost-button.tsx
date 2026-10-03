'use client';

// BOOST on a play-history row (the Listen tab's HISTORY).
//
// IT DOES NOT PAY FROM THE STORED COPY. A history entry is a snapshot taken
// when the episode was heard — days ago, perhaps — and `payableValue` reads
// `episode.value` FIRST, so a stored block would outrank the live feed and pay
// a node the host has since dropped. CLAUDE.md's "an accelerator is never an
// authority" in its money form. So a press loads the episode from its feed
// again (`loadEpisodeFromFeed`, the same round trip `<NoteQueueButton>` and
// `openBoostedEpisode` make) and hands THAT pair to the modal: the feed's own
// listing, so `episode.id` — the money key every boostagram's `itemID` reads —
// is the id the feed lists it under, never a rebuilt one.
//
// A FAILED LOAD OPENS NOTHING. No fallback to the stored block: a ↻ RETRY is
// recoverable, a boost to the wrong payee is not. The failure is drawn, never
// silent — a pressed button that does nothing is the dead control this repo
// keeps paying for.
//
// THE POSITION IS 0 UNLESS THIS EPISODE IS THE ONE PLAYING. `<BoostModal>`
// redirects a boost into a `<podcast:valueTimeSplit>` window only for
// `positionSec > 0`, and a window authored at `startTime: 0` would otherwise
// send a boost pressed from a list to a track the listener is not hearing.

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useApp } from '@/lib/store';
import { loadEpisodeFromFeed } from '@/lib/podcast-meta';
import { boostButtonTitle, boostGate, epKey } from '@/lib/util';
import type { Episode, Podcast } from '@/lib/types';
import { BoltIcon } from '../icons';

// Deferred, as in <EpisodeList>: most history rows are never boosted, and a
// `dynamic()` of a NAMED export must resolve the export or it renders nothing.
const BoostModal = dynamic(
  () => import('../boost-modal').then((m) => m.BoostModal),
  { ssr: false },
);

type State =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'failed' }
  /** The feed answered and BOOST is closed for it — `title` says why. */
  | { kind: 'closed'; title: string };

type Target = { episode: Episode; podcast: Podcast; positionSec: number };

export function HistoryBoostButton({ episode, podcast }: { episode: Episode; podcast: Podcast }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [target, setTarget] = useState<Target | null>(null);

  async function onClick() {
    if (state.kind === 'busy') return;
    // The feed is searched by item guid; without one there is nothing to find.
    if (!episode.guid) {
      setState({ kind: 'closed', title: 'This episode has no guid, so it cannot be loaded again to boost' });
      return;
    }
    setState({ kind: 'busy' });
    const fresh = await loadEpisodeFromFeed(podcast.id, episode.guid).catch(() => null);
    if (!fresh?.episode) { setState({ kind: 'failed' }); return; }
    const gate = boostGate(fresh.episode, fresh.podcast);
    if (!gate.hasValue) {
      setState({ kind: 'closed', title: boostButtonTitle(gate, 'Episode') });
      return;
    }
    // Read at the press, not subscribed: the modal freezes its target at open
    // anyway, and a per-second selector here would re-render every row.
    const s = useApp.getState();
    const playingThis = !!s.current && epKey(s.current.episode) === epKey(fresh.episode);
    setTarget({ episode: fresh.episode, podcast: fresh.podcast, positionSec: playingThis ? s.positionSec : 0 });
    setState({ kind: 'idle' });
  }

  const busy = state.kind === 'busy';
  const failed = state.kind === 'failed';
  const closed = state.kind === 'closed';

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-busy={busy}
        // `title` is not an accessible name, so the label carries the state.
        aria-label={failed ? `Retry loading ${episode.title} to boost it` : `Boost ${episode.title}`}
        title={
          failed ? 'Could not load this episode from its feed — press to try again'
            : closed ? state.title
              : 'Send a boost'
        }
        // <EpisodeList>'s row BOOST: icon-only below sm: with a 44px target,
        // the word from sm:.
        className={`btn-bolt btn-compact self-center flex-shrink-0 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 ${
          busy || closed ? 'opacity-50' : ''
        }`}
      >
        {busy ? <span aria-hidden className="inline-block w-4 text-center">…</span>
          : failed ? <span aria-hidden className="inline-block w-4 text-center">↻</span>
            : <BoltIcon />}
        <span className="hidden sm:inline">{failed ? 'RETRY' : 'BOOST'}</span>
      </button>
      {target && (
        <BoostModal
          episode={target.episode}
          podcast={target.podcast}
          positionSec={target.positionSec}
          onClose={() => setTarget(null)}
        />
      )}
    </>
  );
}
