'use client';
import { useEffect, useRef, useState } from 'react';
import {
  createHtmlPortalNode,
  InPortal,
  OutPortal,
  type HtmlPortalNode,
} from 'react-reverse-portal';
import type Hls from 'hls.js';
import { useApp } from '@/lib/store';
import { fmt } from '@/lib/format';
import { hasValueRecipients, isHlsUrl, isMusicMedium } from '@/lib/util';
import { BoostModal } from './boost-modal';
import { BoltIcon } from './icons';
import { FullscreenPlayer } from './fullscreen-player';
import { TransportControls } from './transport-controls';

export function Player() {
  const { current, isPlaying, setPlaying, setPosition, positionSec, playNext, playerExpanded, setPlayerExpanded } = useApp();
  const audio = useRef<HTMLAudioElement | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [boostOpen, setBoostOpen] = useState(false);
  const [audioErr, setAudioErr] = useState<string | null>(null);
  // Last whole second pushed to the store. timeupdate fires ~4×/sec, but
  // every consumer renders whole seconds (fmt(), step=1 seek bars, chapter
  // highlighting) — gating on the floor cuts store-driven re-renders to 1 Hz.
  const lastTick = useRef(-1);

  // HLS (.m3u8) streams — Nostr live streams — play through a <video> + hls.js
  // instead of the native <audio>. The <video> lives in a reverse portal so it
  // can move between the mini-bar thumbnail and the fullscreen art pane WITHOUT
  // remounting (a remount would kill playback + the hls.js attachment), which
  // is what keeps audio playing when you collapse the fullscreen player.
  const isHls = isHlsUrl(current?.episode.enclosureUrl);
  const isHlsRef = useRef(isHls);
  isHlsRef.current = isHls;
  // Created lazily on the client only — createHtmlPortalNode() touches
  // document, which would crash Next's server render. Player renders null until
  // there's a `current` (client-only state), so the server never needs it and
  // there's no hydration mismatch.
  const videoNodeRef = useRef<HtmlPortalNode | null>(null);
  if (typeof window !== 'undefined' && !videoNodeRef.current) {
    videoNodeRef.current = createHtmlPortalNode({ attributes: { class: 'w-full h-full block' } });
  }
  const videoNode = videoNodeRef.current;
  const hls = useRef<Hls | null>(null);
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  // Source the active media element when the current item changes. Audio and
  // video are mutually exclusive (one `current`), so the inactive element is
  // left srcless/paused — otherwise the <audio> would try to load an .m3u8 and
  // error. HLS attaches via hls.js (or native Safari on canPlayType).
  useEffect(() => {
    lastTick.current = -1;
    setAudioErr(null);

    if (isHls) {
      // Park the audio element so it doesn't error on the m3u8 URL.
      if (audio.current) {
        audio.current.removeAttribute('src');
        audio.current.load();
      }
      const el = video.current;
      const url = current?.episode.enclosureUrl;
      if (!el || !url) return;

      let cancelled = false;
      const nativeHls = el.canPlayType('application/vnd.apple.mpegurl') !== '';
      if (nativeHls) {
        el.src = url;
        if (isPlayingRef.current) el.play().catch(() => {});
      } else {
        import('hls.js').then(({ default: HlsLib }) => {
          if (cancelled || video.current !== el) return;
          if (!HlsLib.isSupported()) {
            el.src = url; // last resort — most browsers will fail, surfaces as onError
            return;
          }
          const inst = new HlsLib({ enableWorker: true, lowLatencyMode: true });
          hls.current = inst;
          inst.loadSource(url);
          inst.attachMedia(el);
          inst.on(HlsLib.Events.ERROR, (_evt, data) => {
            if (data.fatal) setAudioErr('live stream unavailable');
          });
          if (isPlayingRef.current) el.play().catch(() => {});
        });
      }
      return () => {
        cancelled = true;
        if (hls.current) {
          hls.current.destroy();
          hls.current = null;
        }
        if (el) {
          el.removeAttribute('src');
          el.load();
        }
      };
    }

    // Audio path (unchanged behaviour).
    if (!audio.current || !current) return;
    audio.current.src = current.episode.enclosureUrl;
    if (isPlaying) audio.current.play().catch(() => setPlaying(false));
  }, [current?.episode.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Play/pause the active element on store toggles. Reads isHls from a ref so an
  // episode switch (which doesn't change isPlaying) can't re-run this and call
  // play() on a not-yet-sourced element — the source effect above owns first play.
  useEffect(() => {
    const el = isHlsRef.current ? video.current : audio.current;
    if (!el) return;
    if (isPlaying) el.play().catch(() => setPlaying(false));
    else el.pause();
  }, [isPlaying]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!current) return null;
  const { episode, podcast } = current;
  const hasValue = hasValueRecipients(episode.value);
  const isLive = episode.liveStatus === 'live';

  function onMediaError(code: number | undefined) {
    setAudioErr(
      code === 2 ? 'network error while loading audio'
      : code === 3 ? 'audio failed to decode'
      : code === 4 ? 'audio format not supported or URL unreachable'
      : 'audio playback failed',
    );
    setPlaying(false);
  }

  return (
    <>
      {/* The single <video> instance — rendered once, displayed via an OutPortal
          in either the mini-bar or the fullscreen art pane. */}
      {videoNode && (
        <InPortal node={videoNode}>
          <video
            ref={video}
            playsInline
            className="w-full h-full object-contain bg-black"
            onTimeUpdate={(e) => {
              const t = e.currentTarget.currentTime;
              const tick = Math.floor(t);
              if (tick !== lastTick.current) {
                lastTick.current = tick;
                setPosition(t);
              }
            }}
            onError={(e) => onMediaError(e.currentTarget.error?.code)}
          />
        </InPortal>
      )}

      <div
        className="fixed bottom-0 left-0 right-0 z-30 bg-ink/95 backdrop-blur border-t border-bolt/40 pb-[env(safe-area-inset-bottom)] cursor-pointer"
        onClick={() => setPlayerExpanded(true)}
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
          onError={(e) => { if (!isHlsRef.current) onMediaError(e.currentTarget.error?.code); }}
        />
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-4">
          {isHls ? (
            <div className="w-12 h-12 flex-shrink-0 bg-black overflow-hidden border border-bone/20">
              {videoNode && !playerExpanded && <OutPortal node={videoNode} />}
            </div>
          ) : episode.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={episode.image} alt="" className="w-12 h-12 object-cover border border-bone/20 flex-shrink-0" />
          ) : null}
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
        open={playerExpanded}
        duration={duration}
        audioRef={audio}
        videoNode={videoNode}
        isVideo={isHls}
        onClose={() => setPlayerExpanded(false)}
        onBoost={() => { setBoostOpen(true); setPlayerExpanded(false); }}
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
