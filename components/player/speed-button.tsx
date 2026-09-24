'use client';
import { useApp } from '@/lib/store';
import { nextPlaybackRate } from '@/lib/util';

/**
 * The playback-speed chip: each press steps through `PLAYBACK_RATES` (1 → 1.25
 * → 1.5 → 1.75 → 2 → 1), and the label IS the current speed, so the chip says
 * what it is doing without being pressed. <Player> applies the value to the
 * media element and holds a live item at 1×, so the caller hides this on a
 * live item rather than offering a control that does nothing.
 *
 * It sits between the two times under the seek bar, not in the `.tile` row:
 * that row already holds six tiles whenever the show has a value block, and a
 * seventh wrapped onto a line of its own at 390px. The time row has the width
 * to spare at every size. `min-h-[24px]` is the WCAG 2.5.8 floor; `.btn-mini`
 * alone measures under it at this text size.
 */
export function SpeedButton() {
  const rate = useApp((s) => s.playbackRate);
  const setRate = useApp((s) => s.setPlaybackRate);
  const label = `${rate}×`;
  return (
    <button
      type="button"
      onClick={() => setRate(nextPlaybackRate(rate))}
      className={`btn-mini min-h-[24px] min-w-[44px] tabular-nums normal-case ${rate !== 1 ? 'border-bolt/60 text-bolt' : ''}`}
      title="Playback speed"
      aria-label={`Playback speed ${label}, change`}
    >
      {label}
    </button>
  );
}
