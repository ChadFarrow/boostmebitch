'use client';
import { useApp } from '@/lib/store';

/**
 * Shared ⏮ / play-pause / ⏭ transport buttons, rendered as a fragment so they
 * drop straight into the parent's flex row. Reads playback state + queue
 * neighbors from the store; prev/next disable at the queue edges. Used by both
 * the mini-player (`size="sm"`) and the fullscreen player (`size="lg"`).
 */
export function TransportControls({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  const current = useApp((s) => s.current);
  const isPlaying = useApp((s) => s.isPlaying);
  const togglePlay = useApp((s) => s.togglePlay);
  const playNext = useApp((s) => s.playNext);
  const playPrev = useApp((s) => s.playPrev);
  const episodeQueue = useApp((s) => s.episodeQueue);
  if (!current) return null;

  const idx = episodeQueue.findIndex((e) => e.id === current.episode.id);
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < episodeQueue.length - 1;

  const sideBtn = size === 'lg'
    ? 'btn text-xl w-12 h-12 flex items-center justify-center flex-shrink-0'
    : 'btn';
  const playBtn = size === 'lg'
    ? 'btn text-2xl w-14 h-14 flex items-center justify-center flex-shrink-0'
    : 'btn';

  return (
    <>
      <button
        onClick={() => playPrev()}
        disabled={!hasPrev}
        className={`${sideBtn} disabled:opacity-40 disabled:cursor-not-allowed`}
        title="Previous track"
        aria-label="Previous track"
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
        onClick={() => playNext()}
        disabled={!hasNext}
        className={`${sideBtn} disabled:opacity-40 disabled:cursor-not-allowed`}
        title="Next track"
        aria-label="Next track"
      >
        ⏭
      </button>
    </>
  );
}
