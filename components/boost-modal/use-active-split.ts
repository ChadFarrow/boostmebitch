'use client';
import { useEffect, useState } from 'react';
import type { Episode, ValueTimeSplit } from '@/lib/types';
import { hasValueRecipients, splitAtPosition } from '@/lib/util';

/**
 * The `<podcast:valueTimeSplit>` redirect in force at the moment the boost modal
 * opened, if any.
 *
 * `'idle'`       — no window covers this position; boost the show as usual.
 * `'loading'`    — a window covers it, but the artist's value block hasn't
 *                  arrived yet. The caller MUST NOT let a boost go out in this
 *                  state: the window is known synchronously and the target is
 *                  not, so a fast tap would pay the show while the modal was
 *                  about to say it was paying the artist.
 * `'ready'`      — resolved; `split.value` has the artist's recipients.
 * `'unresolved'` — a window covers it and the remote item could not be resolved
 *                  to a value block. Podcast Index doesn't index every album
 *                  feed (the ~50% coverage gap that forced the RSS fallback in
 *                  `resolveValueTimeSplits`), so this is ordinary, not an error.
 *                  Falls back to the show's own block — the spec-correct default,
 *                  since a valueTimeSplit redirects part of the show's value and
 *                  anything that can't be redirected is still the show's.
 */
export type ActiveSplit =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; split: ValueTimeSplit }
  | { state: 'unresolved' };

/**
 * Resolve the split covering `positionSec`, FROZEN at the position the modal
 * opened with.
 *
 * Freezing is the whole design of this hook. The episode keeps playing while
 * the user picks an amount and types a message, so a live-following target
 * would let a boost aimed at the song land on the show because the song ended
 * during typing — the user would have read "paying Copenhagen Time", pressed
 * the button, and paid someone else. The live-stream path follows its target
 * live because it has no fixed timeline to freeze against; here we do.
 *
 * **`positionSec > 0` is the "is this episode actually playing" test**, and it
 * is not a shortcut — it is how every call site already encodes that fact.
 * `<Player>` passes the live position, `<EpisodeDetailView>` passes
 * `isThisPlaying ? positionSec : 0`, and `<Lists>` doesn't pass it at all. A
 * split authored at `startTime: 0` would otherwise redirect a boost pressed
 * from a list row by someone who isn't listening to anything.
 */
export function useActiveSplit(episode: Episode | undefined, positionSec: number): ActiveSplit {
  // Frozen on first render — see above. Deliberately not a dependency of the
  // effect below, so a re-render at a later position can't re-target.
  const [frozen] = useState(() => positionSec);

  const windows = episode?.valueTimeSplits;
  const covering = frozen > 0 ? splitAtPosition(windows, frozen) : null;
  const feedId = episode?.feedId;
  const episodeId = episode?.id;

  const [resolved, setResolved] = useState<ActiveSplit>(() =>
    covering ? { state: 'loading' } : { state: 'idle' },
  );

  useEffect(() => {
    if (!covering || !feedId || !episodeId) {
      setResolved({ state: 'idle' });
      return;
    }
    let cancelled = false;
    setResolved({ state: 'loading' });
    // Same endpoint <BoostAllModal> uses, and it answers with a one-hour CDN
    // cache, so opening the modal twice during a song costs one request.
    fetch(`/api/value-splits?feedId=${feedId}&episodeId=${episodeId}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        // Re-run the SAME window rule over the resolved list rather than
        // matching the unresolved window against it by guid: one rule, one
        // place, and no second definition of "which split is this" to drift.
        const split = splitAtPosition((data.splits as ValueTimeSplit[]) ?? [], frozen);
        setResolved(
          split && hasValueRecipients(split.value)
            ? { state: 'ready', split }
            : { state: 'unresolved' },
        );
      })
      .catch(() => {
        if (!cancelled) setResolved({ state: 'unresolved' });
      });
    return () => { cancelled = true; };
    // `covering` is an element of the episode prop's own array, so its identity
    // is as stable as the episode is. The window's coordinates are listed
    // alongside it so the intent survives a future change that rebuilds the
    // array — and a spurious refire costs one request against a URL the CDN
    // holds for an hour, then sets the same state.
  }, [feedId, episodeId, frozen, covering, covering?.startTime, covering?.duration]);

  return covering ? resolved : { state: 'idle' };
}
