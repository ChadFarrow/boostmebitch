'use client';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { fmt } from '@/lib/format';
import { hasValueRecipients, isMusicMedium } from '@/lib/util';
import { BoostModal } from './boost-modal';
import { BoltIcon } from './icons';
import { FullscreenPlayer } from './fullscreen-player';
import { TransportControls } from './transport-controls';

export function Player() {
  const { current, isPlaying, setPlaying, setPosition, positionSec, playNext } = useApp();
  const audio = useRef<HTMLAudioElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [boostOpen, setBoostOpen] = useState(false);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [audioErr, setAudioErr] = useState<string | null>(null);
  // Last whole second pushed to the store. timeupdate fires ~4×/sec, but
  // every consumer renders whole seconds (fmt(), step=1 seek bars, chapter
  // highlighting) — gating on the floor cuts store-driven re-renders to 1 Hz.
  const lastTick = useRef(-1);

  useEffect(() => {
    if (!audio.current || !current) return;
    audio.current.src = current.episode.enclosureUrl;
    lastTick.current = -1;
    setAudioErr(null);
    if (isPlaying) audio.current.play().catch(() => setPlaying(false));
  }, [current?.episode.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!audio.current) return;
    if (isPlaying) audio.current.play().catch(() => setPlaying(false));
    else audio.current.pause();
  }, [isPlaying]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!current) return null;
  const { episode, podcast } = current;
  const hasValue = hasValueRecipients(episode.value);
  const isLive = episode.liveStatus === 'live';

  return (
    <>
      <div
        className="fixed bottom-0 left-0 right-0 z-30 bg-ink/95 backdrop-blur border-t border-bolt/40 pb-[env(safe-area-inset-bottom)] cursor-pointer"
        onClick={() => setFullscreenOpen(true)}
        role="button"
        aria-label="Open fullscreen player"
      >
        <audio
          ref={audio}
          onTimeUpdate={(e) => {
            const t = e.currentTarget.currentTime;
            const tick = Math.floor(t);
            if (tick !== lastTick.current) {
              lastTick.current = tick;
              setPosition(t);
            }
          }}
          onLoadedMetadata={(e) => { setDuration(e.currentTarget.duration); setAudioErr(null); }}
          onEnded={() => {
            if (current && isMusicMedium(current.podcast)) playNext();
            else setPlaying(false);
          }}
          onError={(e) => {
            const code = e.currentTarget.error?.code;
            setAudioErr(
              code === 2 ? 'network error while loading audio'
              : code === 3 ? 'audio failed to decode'
              : code === 4 ? 'audio format not supported or URL unreachable'
              : 'audio playback failed',
            );
            setPlaying(false);
          }}
        />
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-4">
          {episode.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={episode.image} alt="" className="w-12 h-12 object-cover border border-bone/20 flex-shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-display leading-tight truncate">{episode.title}</div>
            <div className="text-[11px] text-muted truncate">{podcast.title}</div>
            {audioErr && (
              <div className="text-[10px] text-nostr mt-1 truncate">⚠ {audioErr}</div>
            )}
            {isLive ? (
              <div className="flex items-center gap-2 mt-1">
                <span className="stamp text-nostr border-nostr/60 bg-nostr/10 animate-bolt">● LIVE</span>
                <span className="text-[10px] text-muted">streaming now</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 mt-1" onClick={(e) => e.stopPropagation()}>
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
                    lastTick.current = Math.floor(v);
                    setPosition(v);
                  }}
                />
                <span className="text-[10px] text-muted tabular-nums">{fmt(duration)}</span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <TransportControls />
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

      <FullscreenPlayer
        open={fullscreenOpen}
        duration={duration}
        audioRef={audio}
        onClose={() => setFullscreenOpen(false)}
        onBoost={() => { setBoostOpen(true); setFullscreenOpen(false); }}
      />

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
