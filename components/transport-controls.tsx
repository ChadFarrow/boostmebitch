'use client';
import { useApp, epKey } from '@/lib/store';

type NavOverride = { onClick: () => void; disabled: boolean; label: string };

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
 */
export function TransportControls({
  size = 'sm',
  prev,
  next,
  playOnly = false,
}: {
  size?: 'sm' | 'lg';
  prev?: NavOverride;
  next?: NavOverride;
  playOnly?: boolean;
}) {
  const current = useApp((s) => s.current);
  const isPlaying = useApp((s) => s.isPlaying);
  const togglePlay = useApp((s) => s.togglePlay);
  const playNext = useApp((s) => s.playNext);
  const playPrev = useApp((s) => s.playPrev);
  const episodeQueue = useApp((s) => s.episodeQueue);
  const listenQueue = useApp((s) => s.listenQueue);
  if (!current) return null;

  // Is there an episode-level neighbor? The listen queue takes precedence (when
  // the current episode came from it), else the open show's episodeQueue —
  // mirrors playNext/playPrev so the disabled state matches what they'll do.
  const qIdx = listenQueue.findIndex((i) => epKey(i.episode) === epKey(current.episode));
  const inQueue = qIdx >= 0;
  const idx = episodeQueue.findIndex((e) => e.id === current.episode.id);
  // In the listen queue, ⏭ is always live — on the last item it clears it and
  // ends the queue (skip == done), so it's never a dead end.
  const hasEpisodeNext = inQueue ? true : idx >= 0 && idx < episodeQueue.length - 1;
  const hasEpisodePrev = inQueue ? qIdx > 0 : idx > 0;

  // Chapter override steps chapters while any remain; once it's spent (last
  // chapter for next, very start for prev) fall THROUGH to episode/queue nav so
  // ⏭ at the final chapter advances to the next queued episode.
  const stepChapterNext = !!next && !next.disabled;
  const onNext = stepChapterNext ? next!.onClick : () => playNext();
  const nextDisabled = stepChapterNext ? false : !hasEpisodeNext;
  const nextLabel = stepChapterNext ? next!.label : 'Next track';

  const stepChapterPrev = !!prev && !prev.disabled;
  const onPrev = stepChapterPrev ? prev!.onClick : () => playPrev();
  const prevDisabled = stepChapterPrev ? false : !hasEpisodePrev;
  const prevLabel = stepChapterPrev ? prev!.label : 'Previous track';

  const sideBtn = size === 'lg'
    ? 'btn text-xl w-12 h-12 flex items-center justify-center flex-shrink-0'
    : 'btn w-10 h-10 flex items-center justify-center flex-shrink-0';
  const playBtn = size === 'lg'
    ? 'btn text-2xl w-14 h-14 flex items-center justify-center flex-shrink-0'
    : 'btn w-10 h-10 flex items-center justify-center flex-shrink-0';

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
