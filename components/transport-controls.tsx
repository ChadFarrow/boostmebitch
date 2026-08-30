'use client';
import { useApp } from '@/lib/store';
import { nextPlayableIndex } from '@/lib/util';
import { SkipBackIcon, SkipForwardIcon } from './icons';

type NavOverride = { onClick: () => void; disabled: boolean; label: string };

/**
 * How far the skip buttons jump.
 *
 * Asymmetric on purpose, and this is the podcast convention rather than an
 * arbitrary pair: you skip **back** because you missed a sentence, and forward
 * because you want past a whole segment. A symmetric pair makes one of the two
 * jobs take repeated taps.
 *
 * One constant feeds both the jump and the number drawn on the button, so the
 * icon cannot claim 15 while the handler moves 30.
 */
const SKIP_BACK_SEC = 15;
const SKIP_FORWARD_SEC = 30;

/**
 * Shared ⏮ / play-pause / ⏭ transport buttons, rendered as a fragment so they
 * drop straight into the parent's flex row. Reads playback state + queue
 * neighbors from the store; prev/next disable at the queue edges. Used by both
 * the mini-player (`size="sm"`) and the fullscreen player (`size="lg"`).
 *
 * `prev`/`next` override the default episode/track navigation — the fullscreen
 * player passes chapter-stepping handlers when the episode has chapters.
 *
 * `playOnly` renders just the play/pause button (no prev/next) — used for live
 * streams, where stepping the queue isn't meaningful.
 *
 * `sidesOnDesktopOnly` hides ⏮/⏭ below `sm:` while leaving play/pause. The
 * mini-bar passes it because three 40px buttons plus BOOST left the title and
 * seek bar 31px between them on a 390px phone — measured, not estimated. It is
 * a hide, not a drop: the whole mini-bar is a button that opens the fullscreen
 * player, which carries the full transport one tap away. Same trade the
 * `<VideoToggle className="hidden sm:inline-flex">` beside it already makes.
 *
 * `onSkip` adds the −15s / +30s pair flanking play/pause, and is **opt-in
 * rather than default** for two reasons. It takes a RELATIVE delta, so a
 * surface that can't seek simply doesn't pass it — there is no half-working
 * state to guard against. And it is meaningless on a live stream, which has no
 * fixed timeline to jump within; the caller decides, because the caller is the
 * one that already knows `liveStatus`.
 *
 * Skip sits INSIDE the transport cluster rather than beside it because ⏮/⏭ are
 * chapter-stepping whenever the episode has chapters (`buildChapterNav`), so
 * without this pair there is no control anywhere that moves by a fixed
 * interval — the lock screen has had `seekbackward`/`seekforward` since Media
 * Session was wired, and the app itself had nothing.
 *
 * On the mini-bar the pair hides under `sidesOnDesktopOnly` like ⏮/⏭ do, but
 * returns at `lg:` rather than `sm:` — that row is one flex line whose every
 * button is `flex-shrink-0`, so the pair's 96px comes straight out of the title
 * and the seek bar, and the band just above `sm:` has none to give. See
 * `skipShow` below for the measurements. Hiding is honest either way, because
 * the mini-bar is itself a button that opens the fullscreen player, and that
 * player carries all five at every width.
 */
export function TransportControls({
  size = 'sm',
  prev,
  next,
  playOnly = false,
  sidesOnDesktopOnly = false,
  onSkip,
}: {
  size?: 'sm' | 'lg';
  prev?: NavOverride;
  next?: NavOverride;
  playOnly?: boolean;
  sidesOnDesktopOnly?: boolean;
  /** Seek by a signed number of seconds, relative to the live position. */
  onSkip?: (deltaSec: number) => void;
}) {
  const current = useApp((s) => s.current);
  const isPlaying = useApp((s) => s.isPlaying);
  const togglePlay = useApp((s) => s.togglePlay);
  const playNext = useApp((s) => s.playNext);
  const playPrev = useApp((s) => s.playPrev);
  const episodeQueue = useApp((s) => s.episodeQueue);
  if (!current) return null;

  const idx = episodeQueue.findIndex((e) => e.id === current.episode.id);
  // **Enabled means "there is a row this press can land on", which is not the
  // same as "there is a row".** A playlist queue holds one entry per
  // `<podcast:remoteItem>`, including the ones Podcast Index could not resolve,
  // and those have an empty enclosure — so `idx < length - 1` lit ⏭ up over a
  // step `playNext` now refuses to take, which is a control that looks live and
  // does nothing. Both read `nextPlayableIndex`, so they cannot disagree.
  const onPrev = prev?.onClick ?? (() => playPrev());
  const prevDisabled = prev ? prev.disabled : nextPlayableIndex(episodeQueue, idx, -1) < 0;
  const prevLabel = prev?.label ?? 'Previous track';
  const onNext = next?.onClick ?? (() => playNext());
  const nextDisabled = next ? next.disabled : nextPlayableIndex(episodeQueue, idx, 1) < 0;
  const nextLabel = next?.label ?? 'Next track';

  // `hidden sm:flex` rather than `flex` when the sides are desktop-only. Both
  // are display utilities, so this can't be expressed by appending a class to a
  // string that already says `flex` and trusting order — the base `flex` has to
  // not be there.
  const sideShow = sidesOnDesktopOnly ? 'hidden sm:flex' : 'flex';
  const sideBtn = size === 'lg'
    ? `btn text-xl w-12 h-12 ${sideShow} items-center justify-center flex-shrink-0`
    : `btn w-10 h-10 ${sideShow} items-center justify-center flex-shrink-0`;
  const playBtn = size === 'lg'
    ? 'btn text-2xl w-14 h-14 flex items-center justify-center flex-shrink-0'
    : 'btn w-10 h-10 flex items-center justify-center flex-shrink-0';
  // Skip is a hide-not-a-drop like ⏮/⏭ — the mini-bar is itself a button that
  // opens the fullscreen player, which carries all five — but it comes back at
  // `lg:`, NOT at `sm:` with the others, and that is measured rather than
  // tasteful. The pair costs a flat 96px (two 40px buttons plus two 8px gaps),
  // and the mini-bar's text column is already starved just above the `sm:`
  // breakpoint, because 640px is where ⏮/⏭, the AUDIO/VIDEO toggle and BOOST
  // expanding 44→104 all reappear at once. Measured on this row with the pair
  // hidden vs shown: at 1280 the seek bar goes 641→545 and at 1024 385→289,
  // both fine; at 768 it goes 129→33 and at 640 it was already down to 1px
  // before this existed. So `lg:` is the first width where these two buttons
  // are affordable, and below it the fullscreen player is one tap away.
  //
  // A separate variable, never `${sideShow} lg:flex`: both are display
  // utilities at equal specificity, so a string that still says `flex` would be
  // letting Tailwind's emit order decide the layout. Same trap `sideShow`
  // documents above.
  const skipShow = sidesOnDesktopOnly ? 'hidden lg:flex' : 'flex';
  const skipBtn = size === 'lg'
    ? `btn w-12 h-12 ${skipShow} items-center justify-center flex-shrink-0`
    : `btn w-10 h-10 ${skipShow} items-center justify-center flex-shrink-0`;
  const skipGlyph = size === 'lg' ? 'w-6 h-6' : 'w-5 h-5';

  if (playOnly) {
    return (
      <button
        onClick={() => togglePlay()}
        className={playBtn}
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? '❚❚' : '▶'}
      </button>
    );
  }

  return (
    <>
      <button
        onClick={onPrev}
        disabled={prevDisabled}
        className={`${sideBtn} disabled:opacity-40 disabled:cursor-not-allowed`}
        title={prevLabel}
        aria-label={prevLabel}
      >
        ⏮
      </button>
      {onSkip && (
        <button
          onClick={() => onSkip(-SKIP_BACK_SEC)}
          className={skipBtn}
          title={`Back ${SKIP_BACK_SEC} seconds`}
          aria-label={`Skip back ${SKIP_BACK_SEC} seconds`}
        >
          <SkipBackIcon seconds={SKIP_BACK_SEC} className={skipGlyph} />
        </button>
      )}
      <button
        onClick={() => togglePlay()}
        className={playBtn}
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? '❚❚' : '▶'}
      </button>
      {onSkip && (
        <button
          onClick={() => onSkip(SKIP_FORWARD_SEC)}
          className={skipBtn}
          title={`Forward ${SKIP_FORWARD_SEC} seconds`}
          aria-label={`Skip forward ${SKIP_FORWARD_SEC} seconds`}
        >
          <SkipForwardIcon seconds={SKIP_FORWARD_SEC} className={skipGlyph} />
        </button>
      )}
      <button
        onClick={onNext}
        disabled={nextDisabled}
        className={`${sideBtn} disabled:opacity-40 disabled:cursor-not-allowed`}
        title={nextLabel}
        aria-label={nextLabel}
      >
        ⏭
      </button>
    </>
  );
}
