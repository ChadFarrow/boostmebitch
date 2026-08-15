'use client';
import { useApp } from '@/lib/store';
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
  const onPrev = prev?.onClick ?? (() => playPrev());
  const prevDisabled = prev ? prev.disabled : !(idx > 0);
  const prevLabel = prev?.label ?? 'Previous track';
  const onNext = next?.onClick ?? (() => playNext());
  const nextDisabled = next ? next.disabled : !(idx >= 0 && idx < episodeQueue.length - 1);
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
  // Skip shares the side buttons' box so the row reads as one cluster, but
  // never inherits `sideShow`: ⏮/⏭ hide on a cramped mini-bar because the
  // fullscreen player carries them one tap away, and skip has nowhere to be
  // carried to. A surface too narrow for skip should not pass `onSkip`.
  const skipBtn = size === 'lg'
    ? 'btn w-12 h-12 flex items-center justify-center flex-shrink-0'
    : 'btn w-10 h-10 flex items-center justify-center flex-shrink-0';
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
