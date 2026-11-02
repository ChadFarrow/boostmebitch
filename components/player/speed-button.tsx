'use client';
import { useApp } from '@/lib/store';
import { SPEED_SLIDER_RATES, isSteppedRate, nextPlaybackRate } from '@/lib/util';

/**
 * The SPEED tile in the fullscreen player's ⋯ menu: each press steps through
 * `SPEED_CYCLE_RATES` (1 → 1.25 → 1.5 → 1.75 → 2 → 1). The glyph IS the
 * current speed, so the tile answers its own press — the menu stays open
 * after one, and the new number is what the listener sees. <Player> applies
 * the value to the media element and holds a live item at 1×, so the caller
 * hides this on a live item rather than offering a control that does nothing.
 *
 * A speed set on the slider (<SpeedSlider>) shows here too, lit — 1.3× — and
 * the next press goes on to the cycle's next stop above it, 1.5×.
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
  const stepped = isSteppedRate(rate);
  const label = `${stepped ? rate : 1}×`;
  const next = `${nextPlaybackRate(rate)}×`;
  const lit = stepped && rate !== 1;
  if (variant === 'chip') {
    // A fast speed (3.5×/5×) is SHOWN here, unlike on the tile: the chip is
    // alone in the bar, so it is the one place saying what is playing. A
    // press from a fast speed goes back to 1×, as the lit fast tile does.
    // The ↻ is the tile's, for the tile's reason: the control CYCLES.
    const to = stepped ? nextPlaybackRate(rate) : 1;
    return (
      <button
        type="button"
        onClick={() => setRate(to)}
        className={`btn-ghost px-2 tabular-nums normal-case ${rate !== 1 ? 'border-bolt text-bolt' : ''} ${className}`}
        title={`Playback speed — tap for ${to}×`}
        aria-label={`Playback speed ${rate}×, change to ${to}×`}
      >
        {rate}× <span aria-hidden>↻</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setRate(nextPlaybackRate(rate))}
      className={`tile ${lit ? 'border-bolt text-bolt' : ''} ${className}`}
      title={`Playback speed — tap for ${next}`}
      aria-label={`Playback speed ${label}, change to ${next}`}
    >
      {/* The ↻ says the tile CYCLES. Beside 3.5× and 5×, which are on/off
          tiles, a bare "1×" read as one more fixed speed, not the way to
          1.25×–2×. On the word's line, not the number's: "1.75× ↻" at
          text-base is wider than the ~56px a menu tile has inside. */}
      <span aria-hidden className="text-base leading-none tabular-nums normal-case">{label}</span>
      <span>SPEED <span aria-hidden>↻</span></span>
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

/** Where the thumb sits for `rate`: the slider stop nearest to it. */
function sliderIndex(rate: number): number {
  let best = 0;
  SPEED_SLIDER_RATES.forEach((r, i) => {
    if (Math.abs(r - rate) < Math.abs(SPEED_SLIDER_RATES[best] - rate)) best = i;
  });
  return best;
}

/**
 * The speed a key moves the slider to, stepped from the TRUE speed, not from
 * the thumb. At 1.25× the thumb sits on 1.2 (1.2 and 1.3 are equally near, and
 * `sliderIndex` keeps the first), so the browser's own ArrowLeft went from
 * there to 1.1 and 1.2 could not be reached. A fast speed steps from the 1×
 * the slider shows, so ArrowLeft and Home are a way back to 1× too — at the
 * slider's minimum they used to change nothing. Null for a key the slider does
 * not take: ArrowUp/Down move between the menu's items (`useMenuKeys`).
 */
function sliderKeyRate(key: string, rate: number): number | null {
  const stops: readonly number[] = SPEED_SLIDER_RATES;
  const from = isSteppedRate(rate) ? rate : 1;
  switch (key) {
    case 'ArrowRight':
    case 'PageUp':
      return stops.find((r) => r > from) ?? stops[stops.length - 1];
    case 'ArrowLeft':
    case 'PageDown':
      return [...stops].reverse().find((r) => r < from) ?? stops[0];
    case 'Home':
      return stops[0];
    case 'End':
      return stops[stops.length - 1];
    default:
      return null;
  }
}

/**
 * The stops that carry a number under their tick. EVERY stop has a tick you
 * can see (the owner's request, 2026-11-01: a tick for each 0.1), and these
 * three are taller and labelled — a number under each of the eleven does not
 * fit a 224px menu.
 */
const SLIDER_LABELS: readonly number[] = [1, 1.5, 2];

/**
 * The fine speed control in the ⋯ menu: 1× to 2× in 0.1 steps
 * (`SPEED_SLIDER_RATES`), a full-width row under SPEED and the two fast tiles,
 * which it adds to rather than replaces. It writes the same store value as
 * SPEED, so the two always agree: a slider speed lights the tile with its
 * number, and SPEED's next press goes on from it.
 *
 * The input's value is an INDEX into the list, never the speed: a speed read
 * back from a range input is whatever float the browser serialized, and the
 * storage allowlist reads `1.2000000000000002` back as 1×. A speed between two
 * stops (the cycle's 1.25× and 1.75×) puts the thumb on the nearest one, and a
 * fast speed puts it at 1×, as SPEED shows 1× then. `aria-valuetext` names the
 * TRUE speed at every speed, 3.5× and 5× included: a screen reader told "1×"
 * while the audio plays at 3.5× is told something false.
 *
 * Because the thumb can sit on a stop that is not the speed, two things the
 * browser does for a range input are not enough here. Its arrow keys step from
 * the thumb, so the keys are ours (`sliderKeyRate`). And a tap on the stop the
 * thumb already sits on changes no value, so no change event fires: at 1.25× a
 * tap on 1.2 did nothing, and at 3.5× a tap on 1× did nothing. The click sets
 * the stop the thumb shows; after a drag that is the speed already, so it is a
 * no-op.
 *
 * `.seek` for the look of the scrub bar, `.seek-speed` for a 24px box, and
 * the ticks inset by half a thumb, the inset <ChapterTicks> uses, because a
 * range input's thumb centre runs from thumb/2 to width - thumb/2. Hidden on a
 * live item by the caller, like SPEED.
 */
export function SpeedSlider() {
  const rate = useApp((s) => s.playbackRate);
  const setRate = useApp((s) => s.setPlaybackRate);
  const shown = isSteppedRate(rate) ? rate : 1;
  const last = SPEED_SLIDER_RATES.length - 1;
  return (
    <div className="col-span-3 px-1 pt-1">
      <input
        type="range"
        className="seek seek-speed block w-full"
        min={0}
        max={last}
        step={1}
        value={sliderIndex(shown)}
        onChange={(e) => setRate(SPEED_SLIDER_RATES[Number(e.target.value)] ?? 1)}
        onKeyDown={(e) => {
          const to = sliderKeyRate(e.key, rate);
          if (to === null) return;
          e.preventDefault();
          if (to !== rate) setRate(to);
        }}
        onClick={(e) => {
          // The store, not `rate`: the press's own change event may have set
          // a new speed that this render's closure has not seen.
          const to = SPEED_SLIDER_RATES[Number(e.currentTarget.value)];
          if (to !== undefined && to !== useApp.getState().playbackRate) setRate(to);
        }}
        aria-label="Playback speed, 1× to 2× in 0.1 steps"
        aria-valuetext={`${rate}×`}
      />
      <div aria-hidden className="relative h-6 mx-[calc(var(--seek-thumb)/2)]">
        {SPEED_SLIDER_RATES.map((r, i) => {
          const major = SLIDER_LABELS.includes(r);
          return (
            <span
              key={r}
              className="absolute top-0 -translate-x-1/2 flex flex-col items-center gap-0.5"
              style={{ left: `${(i / last) * 100}%` }}
            >
              <span data-speed-tick="" className={`w-px ${major ? 'h-3 bg-bone/80' : 'h-2 bg-bone/60'}`} />
              {major && (
                <span className="font-mono text-[10px] leading-none tabular-nums text-muted">{r}×</span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
