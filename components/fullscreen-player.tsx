'use client';
import { RefObject } from 'react';
import { useApp } from '@/lib/store';
import { BoltIcon } from './icons';
import { PodcastCover } from './podcast-cover';

function fmt(t: number) {
  if (!isFinite(t)) return '0:00';
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60).toString().padStart(2, '0');
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s}`;
  return `${m}:${s}`;
}

export function FullscreenPlayer({
  open,
  duration,
  audioRef,
  onClose,
  onBoost,
}: {
  open: boolean;
  duration: number;
  audioRef: RefObject<HTMLAudioElement | null>;
  onClose: () => void;
  onBoost: () => void;
}) {
  const { current, isPlaying, setPlaying, positionSec, setPosition } = useApp();
  if (!current) return null;

  const { episode, podcast } = current;
  const isLive = episode.liveStatus === 'live';
  const hasValue = !!episode.value && episode.value.recipients?.length > 0;

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col bg-ink transition-transform duration-300 ease-in-out ${open ? 'translate-y-0' : 'translate-y-full pointer-events-none'}`}
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 pt-4 pb-2 flex-shrink-0">
        <span className="text-[11px] text-muted uppercase tracking-widest">Now Playing</span>
        <button onClick={onClose} className="btn-ghost px-2 py-1 text-base leading-none" aria-label="Close fullscreen player">
          ✕
        </button>
      </div>

      {/* Artwork — fills remaining vertical space, centered */}
      <div className="flex-1 flex items-center justify-center px-10 min-h-0 py-4">
        <div className="w-full max-w-sm aspect-square">
          <PodcastCover
            image={episode.image ?? podcast.image}
            artwork={podcast.artwork}
            title={podcast.title}
            seed={podcast.id?.toString()}
            className="w-full h-full rounded-xl border border-bone/10 shadow-2xl"
          />
        </div>
      </div>

      {/* Metadata */}
      <div className="px-8 text-center flex-shrink-0">
        <div className="font-display text-xl leading-snug line-clamp-2">{episode.title}</div>
        <div className="text-sm text-muted mt-1 truncate">{podcast.title}</div>
      </div>

      {/* Playback controls */}
      <div className="px-8 pt-6 pb-8 flex flex-col gap-5 flex-shrink-0 w-full max-w-sm mx-auto">
        {isLive ? (
          <div className="flex items-center justify-center gap-2">
            <span className="stamp text-nostr border-nostr/60 bg-nostr/10 animate-bolt">● LIVE</span>
            <span className="text-xs text-muted">streaming now</span>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <input
              type="range"
              className="seek w-full"
              min={0}
              max={duration || 0}
              value={positionSec}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (audioRef.current) audioRef.current.currentTime = v;
                setPosition(v);
              }}
            />
            <div className="flex justify-between text-[11px] text-muted tabular-nums">
              <span>{fmt(positionSec)}</span>
              <span>{fmt(duration)}</span>
            </div>
          </div>
        )}

        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => setPlaying(!isPlaying)}
            className="btn text-2xl w-14 h-14 flex items-center justify-center"
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? '❚❚' : '▶'}
          </button>
          <button
            onClick={onBoost}
            disabled={!hasValue}
            className="btn-bolt disabled:opacity-40 disabled:cursor-not-allowed"
            title={hasValue ? 'Send a boost' : 'Episode has no value block'}
          >
            <BoltIcon /> BOOST
          </button>
        </div>
      </div>
    </div>
  );
}
