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

/**
 * Seconds behind the anchor, and the anchor to keep.
 *
 * A play head that moved AHEAD of the clock (hls.js snapping forward to its
 * live sync point after `playing`) is not "negative behind": it is a new, better
 * starting point, so the anchor moves there and a later gap counts in full.
 */
export function liveLag(
  anchor: LiveAnchor,
  wallSec: number,
  mediaSec: number,
): { behindSec: number; anchor: LiveAnchor } {
  const behindSec = (wallSec - anchor.wallSec) - (mediaSec - anchor.mediaSec);
  if (behindSec < 0) return { behindSec: 0, anchor: { wallSec, mediaSec } };
  return { behindSec, anchor };
}

/** The whole seconds to show: 0 (say nothing) under `LIVE_BEHIND_MIN_SEC`. */
export function behindToShow(behindSec: number): number {
  return behindSec < LIVE_BEHIND_MIN_SEC ? 0 : Math.round(behindSec);
}
