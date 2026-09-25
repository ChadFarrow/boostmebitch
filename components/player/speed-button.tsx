'use client';
import { useApp } from '@/lib/store';
import { PLAYBACK_RATES, SPEED_CYCLE_RATES, nextPlaybackRate } from '@/lib/util';
import { TileMenu } from './tile-menu';

/**
 * The SPEED tile in the fullscreen player's ⋯ menu: each press steps through
 * `SPEED_CYCLE_RATES` (1 → 1.25 → 1.5 → 1.75 → 2 → 1). The glyph IS the
 * current speed, so the tile answers its own press — the menu stays open
 * after one, and the new number is what the listener sees. <Player> applies
 * the value to the media element and holds a live item at 1×, so the caller
 * hides this on a live item rather than offering a control that does nothing.
 *
 * While a fast tile is on (<FastSpeedButton>), this one shows 1× and is not
 * lit: the lit tile is the one that names the speed playing, and two lit
 * tiles saying 3.5× would ask which one to press to turn it off.
 *
 * `variant="chip"` is the same control for the desktop mini-bar: the one
 * cycle, the one store action, drawn as a `.btn-ghost` beside the transport.
 * The caller shows it from lg: only — below that the bar has no width to give.
 */
export function SpeedButton({ variant = 'tile', className = '' }: { variant?: 'tile' | 'chip'; className?: string } = {}) {
  const rate = useApp((s) => s.playbackRate);
  const setRate = useApp((s) => s.setPlaybackRate);
  const inCycle = (SPEED_CYCLE_RATES as readonly number[]).includes(rate);
  const label = `${inCycle ? rate : 1}×`;
  const lit = inCycle && rate !== 1;
  if (variant === 'chip') {
    // A fast speed (3.5×/5×) is SHOWN here, unlike on the tile: the chip is
    // alone in the bar, so it is the one place saying what is playing. A
    // press from a fast speed goes back to 1×, as the lit fast tile does.
    return (
      <button
        type="button"
        onClick={() => setRate(inCycle ? nextPlaybackRate(rate) : 1)}
        className={`btn-ghost px-2 tabular-nums normal-case ${rate !== 1 ? 'border-bolt text-bolt' : ''} ${className}`}
        title="Playback speed"
        aria-label={`Playback speed ${rate}×, change`}
      >
        {rate}×
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setRate(nextPlaybackRate(rate))}
      className={`tile ${lit ? 'border-bolt text-bolt' : ''} ${className}`}
      title="Playback speed"
      aria-label={`Playback speed ${label}, change`}
    >
      <span aria-hidden className="text-base leading-none tabular-nums normal-case">{label}</span>
      SPEED
    </button>
  );
}

/**
 * The word under a fast tile's speed. 5× is PERMANERD, at the user's request —
 * and at `tracking-normal`, because nine letters at `.tile`'s `tracking-wider`
 * measure ~58px against the ~56px a tile in the 224px menu has inside its
 * padding. Without the tracking it is ~54px and clears both edges.
 */
const FAST_WORD: Record<number, string> = { 5: 'Permanerd' };

/**
 * One fast speed as a tile of its own — 3.5× or 5×. A press turns it on; a
 * press while it is on goes back to 1×, so the lit tile is also the way off.
 * Hidden on a live item for the same reason as SPEED.
 */
export function FastSpeedButton({ rate: target }: { rate: number }) {
  const rate = useApp((s) => s.playbackRate);
  const setRate = useApp((s) => s.setPlaybackRate);
  const on = rate === target;
  return (
    <button
      type="button"
      onClick={() => setRate(on ? 1 : target)}
      className={`tile ${on ? 'border-bolt text-bolt' : ''}`}
      title={on ? 'Back to normal speed' : `Play at ${target}×`}
      aria-label={on ? `Playback speed ${target}×, turn off` : `Playback speed ${target}×`}
      aria-pressed={on}
    >
      <span aria-hidden className="text-base leading-none tabular-nums normal-case">{target}×</span>
      {FAST_WORD[target] ? <span className="tracking-normal">{FAST_WORD[target]}</span> : 'SPEED'}
    </button>
  );
}

/**
 * SPEED as ONE tile that opens a list of every rate, for the now-playing
 * screen's desktop row — where SPEED, 3.5× and 5× as three tiles read as a
 * lot of buttons for one setting. The phone's ⋯ menu keeps the three tiles.
 *
 * Every rate is one press away, which is the property the fast tiles were
 * split out for (5× used to cost six presses of the cycle). The list is
 * `PLAYBACK_RATES`, the same allowlist the storage accessor reads, so it can
 * offer nothing the player would refuse. The face names the speed playing and
 * is lit whenever that is not 1×. Hidden on a live item, like the tiles.
 */
export function SpeedMenuTile() {
  const rate = useApp((s) => s.playbackRate);
  const setRate = useApp((s) => s.setPlaybackRate);
  return (
    <TileMenu
      label={`Playback speed ${rate}×, change`}
      lit={rate !== 1}
      menuWidth={232}
      columns={4}
      trigger={
        <>
          <span aria-hidden className="text-base leading-none tabular-nums normal-case">{rate}×</span>
          SPEED
        </>
      }
    >
      {(close) =>
        PLAYBACK_RATES.map((r) => (
          <button
            key={r}
            type="button"
            role="menuitemradio"
            aria-checked={r === rate}
            onClick={() => { setRate(r); close(); }}
            className={`btn-mini justify-center px-0 py-2 text-xs tabular-nums normal-case ${r === rate ? 'border-bolt text-bolt' : ''} ${FAST_WORD[r] ? 'col-span-2' : ''}`}
          >
            {r}×{FAST_WORD[r] ? <span className="uppercase tracking-normal">{FAST_WORD[r]}</span> : null}
          </button>
        ))
      }
    </TileMenu>
  );
}
