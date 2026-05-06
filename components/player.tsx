'use client';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { BoostModal } from './boost-modal';
import { BoltIcon } from './icons';

function fmt(t: number) {
  if (!isFinite(t)) return '0:00';
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60).toString().padStart(2, '0');
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s}`;
  return `${m}:${s}`;
}

export function Player() {
  const { current, isPlaying, setPlaying, setPosition, positionSec } = useApp();
  const audio = useRef<HTMLAudioElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [boostOpen, setBoostOpen] = useState(false);

  useEffect(() => {
    if (!audio.current || !current) return;
    audio.current.src = current.episode.enclosureUrl;
    if (isPlaying) audio.current.play().catch(() => setPlaying(false));
  }, [current?.episode.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!audio.current) return;
    if (isPlaying) audio.current.play().catch(() => setPlaying(false));
    else audio.current.pause();
  }, [isPlaying]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!current) return null;
  const { episode, podcast } = current;
  const hasValue = !!episode.value && episode.value.recipients?.length > 0;
  const isLive = episode.liveStatus === 'live';

  return (
    <>
      <div className="fixed bottom-0 left-0 right-0 z-30 bg-ink/95 backdrop-blur border-t border-bolt/40 pb-[env(safe-area-inset-bottom)]">
        <audio
          ref={audio}
          onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onEnded={() => setPlaying(false)}
        />
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-4">
          {episode.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={episode.image} alt="" className="w-12 h-12 object-cover border border-bone/20 flex-shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-display leading-tight truncate">{episode.title}</div>
            <div className="text-[11px] text-muted truncate">{podcast.title}</div>
            {isLive ? (
              <div className="flex items-center gap-2 mt-1">
                <span className="stamp text-nostr border-nostr/60 bg-nostr/10 animate-bolt">● LIVE</span>
                <span className="text-[10px] text-muted">streaming now</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[10px] text-muted tabular-nums">{fmt(positionSec)}</span>
                <input
                  type="range"
                  className="seek flex-1"
                  min={0}
                  max={duration || 0}
                  value={positionSec}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (audio.current) audio.current.currentTime = v;
                    setPosition(v);
                  }}
                />
                <span className="text-[10px] text-muted tabular-nums">{fmt(duration)}</span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setPlaying(!isPlaying)} className="btn">
              {isPlaying ? '❚❚' : '▶'}
            </button>
            <button
              onClick={() => setBoostOpen(true)}
              disabled={!hasValue}
              className="btn-bolt disabled:opacity-40 disabled:cursor-not-allowed"
              title={hasValue ? 'Send a boost' : 'Episode has no value block'}
            >
              <BoltIcon /> BOOST
            </button>
          </div>
        </div>
      </div>

      {boostOpen && hasValue && (
        <BoostModal
          episode={episode}
          podcast={podcast}
          positionSec={isLive ? 0 : positionSec}
          onClose={() => setBoostOpen(false)}
        />
      )}
    </>
  );
}
