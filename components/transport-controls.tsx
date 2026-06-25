'use client';
import { useApp } from '@/lib/store';

type NavOverride = { onClick: () => void; disabled: boolean; label: string };

/**
 * Shared ⏮ / play-pause / ⏭ transport buttons, rendered as a fragment so they
 * drop straight into the parent's flex row. Reads playback state + queue
 * neighbors from the store; prev/next disable at the queue edges. Used by both
 * the mini-player (`size="sm"`) and the fullscreen player (`size="lg"`).
 *
 * `prev`/`next` override the default episode/track navigation — the fullscreen
 * player passes chapter-stepping handlers when the episode has chapters.
 */
export function TransportControls({
  size = 'sm',
  prev,
  next,
}: {
  size?: 'sm' | 'lg';
  prev?: NavOverride;
  next?: NavOverride;
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

  const sideBtn = size === 'lg'
    ? 'btn text-xl w-12 h-12 flex items-center justify-center flex-shrink-0'
    : 'btn w-10 h-10 flex items-center justify-center flex-shrink-0';
  const playBtn = size === 'lg'
    ? 'btn text-2xl w-14 h-14 flex items-center justify-center flex-shrink-0'
    : 'btn w-10 h-10 flex items-center justify-center flex-shrink-0';

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
      <button
        onClick={() => togglePlay()}
        className={playBtn}
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? '❚❚' : '▶'}
      </button>
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
