/**
 * How far behind the live edge a live item is playing — the number under the
 * `● LIVE` stamp, and the gate on its `⏭ GO LIVE` button (`<LiveEdge>`).
 *
 * **THE CLOCK IS THE ONLY WITNESS.** Measured 2026-11-12 on Homegrown Hits 158
 * (an Icecast MP3, 128 kbps) in Chrome: a 12 s network gap, made by a proxy that
 * held the bytes and then let them through, left playback 10.2 s behind, and it
 * stayed there — a live item plays at 1×, so nothing catches up. Through all of
 * it `buffered.end - currentTime` stayed under 2 s: the element reads the
 * socket only as fast as it plays, so the backlog sits in the network and never
 * shows in `buffered`. What does show it is the wall clock running on while
 * `currentTime` does not.
 *
 * So the measure is relative to a FRESH CONNECT, the moment the source first
 * played: wall seconds since then, minus media seconds played since then. That
 * is also the only distance a reconnect can recover — a fresh connect is where
 * GO LIVE lands — so it is the honest number to put beside that button.
 *
 * **WHY 5 s.** The same stream sends ~54 KB (3-4 s of audio) at once on
 * connect. A GO LIVE pressed under that replays audio the listener has just
 * heard, which is the complaint this exists to answer.
 *
 * Import-free on purpose: `npm run e2e:livecatchup` loads it under
 * `--experimental-strip-types` and checks the same function `<Player>` runs.
 * The rest of the reasoning: docs/ui.md, "Catch up to live".
 */

/** Where the clock was started: the wall time and the media time, together. */
export interface LiveAnchor {
  wallSec: number;
  mediaSec: number;
}

/** Below this the row says `streaming now`, and no button is offered. */
export const LIVE_BEHIND_MIN_SEC = 5;
/** Once shown, the row stays until the lag falls under this. */
export const LIVE_BEHIND_HIDE_SEC = 4;
/** Once shown, the number moves only when the lag is this far from it. */
export const LIVE_BEHIND_STEP_SEC = 0.75;

/**
 * Seconds behind the anchor, and the anchor to keep.
 *
 * A play head that moved AHEAD of the clock (hls.js snapping forward to its
 * live sync point after `playing`) is not "negative behind": it is a new, better
 * starting point, so the anchor moves there and a later gap counts in full.
 *
 * A play head BEFORE its own anchor is not a measurement at all, and answers
 * `null` with the anchor kept. hls.js's `recoverMediaError` re-attaches the
 * media, whose `load()` puts `currentTime` at 0 for a moment; the subtraction
 * would read "3600 s behind" an hour into a show, until hls.js seeks back.
 */
export function liveLag(
  anchor: LiveAnchor,
  wallSec: number,
  mediaSec: number,
): { behindSec: number | null; anchor: LiveAnchor } {
  if (mediaSec < anchor.mediaSec) return { behindSec: null, anchor };
  const behindSec = (wallSec - anchor.wallSec) - (mediaSec - anchor.mediaSec);
  if (behindSec < 0) return { behindSec: 0, anchor: { wallSec, mediaSec } };
  return { behindSec, anchor };
}

/**
 * The whole seconds to show — 0 says nothing — given what is shown now.
 *
 * WITH HYSTERESIS, because the input jitters: `currentTime` inside a
 * `timeupdate` is where the event was queued, tens of ms stale and more on a
 * busy main thread. Without it a lag that settles on 5.0 s blinks GO LIVE on and
 * off every tick, under the listener's thumb, and one on N.5 s flips the number
 * (and the button's accessible name) between N and N+1. So the row appears at
 * `LIVE_BEHIND_MIN_SEC`, leaves under `LIVE_BEHIND_HIDE_SEC`, and a shown number
 * moves only `LIVE_BEHIND_STEP_SEC` or more away from it.
 */
export function behindToShow(behindSec: number, shownSec = 0): number {
  if (shownSec <= 0) return behindSec < LIVE_BEHIND_MIN_SEC ? 0 : Math.round(behindSec);
  if (behindSec < LIVE_BEHIND_HIDE_SEC) return 0;
  return Math.abs(behindSec - shownSec) < LIVE_BEHIND_STEP_SEC ? shownSec : Math.round(behindSec);
}
