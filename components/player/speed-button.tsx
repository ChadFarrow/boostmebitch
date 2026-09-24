'use client';
import { useApp } from '@/lib/store';
import { nextPlaybackRate } from '@/lib/util';

/**
 * The SPEED tile in the fullscreen player's ⋯ menu: each press steps through
 * `PLAYBACK_RATES` (1 → 1.25 → 1.5 → 1.75 → 2 → 3.5 → 5 → 1). The glyph IS the
 * current speed, so the tile answers its own press — the menu stays open
 * after one, and the new number is what the listener sees. <Player> applies
 * the value to the media element and holds a live item at 1×, so the caller
 * hides this on a live item rather than offering a control that does nothing.
 */
export function SpeedButton() {
  const rate = useApp((s) => s.playbackRate);
  const setRate = useApp((s) => s.setPlaybackRate);
  const label = `${rate}×`;
  return (
    <button
      type="button"
      onClick={() => setRate(nextPlaybackRate(rate))}
      className={`tile ${rate !== 1 ? 'border-bolt text-bolt' : ''}`}
      title="Playback speed"
      aria-label={`Playback speed ${label}, change`}
    >
      <span aria-hidden className="text-base leading-none tabular-nums normal-case">{label}</span>
      SPEED
    </button>
  );
}
