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
import { hasValueRecipients, isHlsUrl, isMusicMedium, pickVideoAlternate, pipSupported, togglePip } from '@/lib/util';
import { useChapters, chapterUrlFor, chapterState, buildChapterNav } from '@/lib/chapters';
import { useTranscript, transcriptSourceFor, transcriptIndexAt } from '@/lib/transcript';
import { ChapterTicks, ChapterLabel } from './chapter-ui';
import { BoostModal } from './boost-modal';
import { BoltIcon, PipIcon } from './icons';
import { FullscreenPlayer } from './fullscreen-player';
import { TransportControls } from './transport-controls';
import { VideoToggle } from './video-toggle';

export function Player() {
  // Per-field selectors, not a bare `useApp()`. In zustand v5 a selector-less
  // call re-renders on EVERY store write; <Player> is mounted in the root
  // layout and owns the fullscreen player, chapters/transcript fetches, and the
  // reverse-portal <video>, so an unrelated write (mute, favorite, boostsTick,
  // selectPodcast, signInOpen, walletOpen, …) would re-render this whole heavy
  // subtree on top of the 1 Hz position ticks. Actions are stable refs — free
  // to select individually.
  const current = useApp((s) => s.current);
  const isPlaying = useApp((s) => s.isPlaying);
  const positionSec = useApp((s) => s.positionSec);
  const playerExpanded = useApp((s) => s.playerExpanded);
  const videoMode = useApp((s) => s.videoMode);
  const seekReq = useApp((s) => s.seekReq);
  const setPlaying = useApp((s) => s.setPlaying);
  const setPosition = useApp((s) => s.setPosition);
  const playNext = useApp((s) => s.playNext);
  const setPlayerExpanded = useApp((s) => s.setPlayerExpanded);
  const audio = useRef<HTMLAudioElement | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [boostOpen, setBoostOpen] = useState(false);
  const [audioErr, setAudioErr] = useState<string | null>(null);
  // Whether the active <video> can enter Picture-in-Picture (HLS streams only —
  // the native <audio> can't). Recomputed per item; gates the PiP button.
  const [pipOk, setPipOk] = useState(false);
  // Last whole second pushed to the store. timeupdate fires ~4×/sec, but
  // every consumer renders whole seconds (fmt(), step=1 seek bars, chapter
  // highlighting) — gating on the floor cuts store-driven re-renders to 1 Hz.
  const lastTick = useRef(-1);

  // Video plays through a <video> + (for HLS) hls.js instead of the native
  // <audio>. Two sources feed the <video>: (1) an HLS (.m3u8) enclosure — a
  // Nostr live stream; (2) a video <podcast:alternateEnclosure> the user opted
  // into via <VideoToggle> (videoMode). The <video> lives in a reverse portal so
  // it can move between the mini-bar thumbnail and the fullscreen art pane
  // WITHOUT remounting (a remount would kill playback + the hls.js attachment),
  // which is what keeps playback alive when you collapse the fullscreen player.
  const isHls = isHlsUrl(current?.episode.enclosureUrl);
  const videoAlt = current ? pickVideoAlternate(current.episode) : undefined;
  // The URL that should play through the <video>, if any. Live HLS wins; else
  // the chosen video alternate when the user toggled video on.
  const videoUrl = isHls
    ? current?.episode.enclosureUrl
    : videoMode && videoAlt
      ? videoAlt.source
      : undefined;
  const isVideo = !!videoUrl;
  // isHlsRef gates the live-stream-only foreground-resume nudge; isVideoRef
  // selects the active media element (video vs audio) in the other effects.
  const isHlsRef = useRef(isHls);
  isHlsRef.current = isHls;
  const isVideoRef = useRef(isVideo);
  isVideoRef.current = isVideo;
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
  const recoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Watchdog for the foreground-resume nudge — see the visibilitychange effect.
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  // Source the active media element when the current item changes. Audio and
  // video are mutually exclusive (one `current`), so the inactive element is
  // left srcless/paused — otherwise the <audio> would try to load an .m3u8 and
  // error. HLS attaches via hls.js (or native Safari on canPlayType).
  useEffect(() => {
    lastTick.current = -1;
    setAudioErr(null);

    if (isVideo) {
      // Park the audio element so it doesn't error on the video URL.
      if (audio.current) {
        audio.current.removeAttribute('src');
        audio.current.load();
      }
      const el = video.current;
      const url = videoUrl;
      if (!el || !url) return;

      // Start position: preserved when toggling audio→video mid-play (positionSec
      // holds the live position), and set by play(ep, pod, startSec). Applied on
      // loadedmetadata; 0 (a fresh play, or a live stream) → no seek.
      const startAt = useApp.getState().positionSec;
      const seekOnLoad = () => { if (startAt > 0) el.currentTime = startAt; };

      // A plain progressive video (mp4/webm) — an alternateEnclosure rendition —
      // plays natively; only HLS needs hls.js. isHlsUrl(url) distinguishes them.
      if (!isHlsUrl(url)) {
        el.src = url;
        el.addEventListener('loadedmetadata', seekOnLoad, { once: true });
        if (isPlayingRef.current) el.play().catch(() => {});
        return () => {
          el.removeEventListener('loadedmetadata', seekOnLoad);
          el.removeAttribute('src');
          el.load();
        };
      }

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
          // We're a *viewer* client, not the broadcaster: smooth playback beats
          // sub-second latency. lowLatencyMode hugged the live edge with a tiny
          // buffer, so any jitter stalled playback and then hard-seeked forward to
          // catch up — skipping content. Default live behaviour keeps a ~3-segment
          // cushion and gently catches up (maxLiveSyncPlaybackRate) instead of
          // seeking past missed segments.
          const inst = new HlsLib({
            enableWorker: true,
            lowLatencyMode: false,
            liveSyncDurationCount: 4,
            maxLiveSyncPlaybackRate: 1.5,
          });
          hls.current = inst;
          inst.loadSource(url);
          inst.attachMedia(el);
          // Fatal hls.js errors used to freeze the stream until a hard page
          // refresh — the old handler only showed a message and never restarted
          // the loader, so the <video> stayed dead while the broadcaster was
          // perfectly fine. Live streams throw fatal NETWORK errors constantly
          // (a segment 404s / the playlist reload times out as the broadcaster
          // rolls the live window, a CDN blip, a brief broadcaster dropout), so
          // recover in place the way hls.js documents — this is the auto-version
          // of the hard refresh. Counters are *consecutive* failures: a buffered
          // fragment resets them, so an hours-long stream with occasional blips
          // never exhausts the budget, but a genuinely dead stream settles into
          // a slow reconnect poll instead of hammering.
          let netRetries = 0;
          let mediaRetries = 0;
          const clearRecover = () => {
            if (recoverTimer.current) { clearTimeout(recoverTimer.current); recoverTimer.current = null; }
          };
          inst.on(HlsLib.Events.FRAG_BUFFERED, () => {
            netRetries = 0;
            mediaRetries = 0;
            setAudioErr(null);
          });
          inst.on(HlsLib.Events.ERROR, (_evt, data) => {
            if (!data.fatal) return;
            // hls.js's `details` code (manifestLoadError, fragLoadError, …) is
            // the only clue to WHAT failed — surface it so a stuck stream is
            // diagnosable from the UI instead of reading as a silent black box.
            const detail = data.details ? ` (${data.details})` : '';
            if (data.type === HlsLib.ErrorTypes.NETWORK_ERROR) {
              // Backoff 1s→15s so a longer dropout doesn't spin the network; no
              // hard give-up — keep retrying so the stream auto-resumes when the
              // broadcaster comes back (what a manual refresh used to do).
              setAudioErr(`stream unreachable — reconnecting…${detail}`);
              clearRecover();
              const delay = Math.min(1000 * 2 ** netRetries, 15000);
              netRetries++;
              recoverTimer.current = setTimeout(() => {
                if (hls.current === inst) inst.startLoad();
              }, delay);
            } else if (data.type === HlsLib.ErrorTypes.MEDIA_ERROR && mediaRetries++ < 3) {
              inst.recoverMediaError();
            } else {
              clearRecover();
              setAudioErr(`live stream unavailable${detail}`);
              inst.destroy();
              if (hls.current === inst) hls.current = null;
            }
          });
          if (isPlayingRef.current) el.play().catch(() => {});
        });
      }
      return () => {
        cancelled = true;
        if (recoverTimer.current) { clearTimeout(recoverTimer.current); recoverTimer.current = null; }
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
    const el = audio.current;
    el.src = current.episode.enclosureUrl;
    // Start position: play(episode, podcast, startSec) sets positionSec before
    // this effect runs, so an episode launched from a transcript line / chapter
    // begins there. Applied once metadata is ready (currentTime isn't settable
    // before). positionSec 0 (a normal play) → no seek.
    const startAt = useApp.getState().positionSec;
    if (startAt > 0) {
      const seekOnLoad = () => { el.currentTime = startAt; };
      el.addEventListener('loadedmetadata', seekOnLoad, { once: true });
    }
    if (isPlaying) el.play().catch(() => setPlaying(false));
  }, [current?.episode.id, videoMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Play/pause the active element on store toggles. Reads isVideo from a ref so
  // an episode switch (which doesn't change isPlaying) can't re-run this and call
  // play() on a not-yet-sourced element — the source effect above owns first play.
  useEffect(() => {
    const el = isVideoRef.current ? video.current : audio.current;
    if (!el) return;
    if (isPlaying) el.play().catch(() => setPlaying(false));
    else el.pause();
  }, [isPlaying]); // eslint-disable-line react-hooks/exhaustive-deps

  // Honor a seek request for the current episode (from a transcript line /
  // chapter tap in the detail view). Fires per nonce, so re-clicking the same
  // line seeks again.
  useEffect(() => {
    if (!seekReq) return;
    const el = isVideoRef.current ? video.current : audio.current;
    if (!el) return;
    el.currentTime = seekReq.t;
    lastTick.current = Math.floor(seekReq.t);
    setPosition(seekReq.t);
  }, [seekReq]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resume a live HLS stream when the tab comes back to the foreground. iOS
  // Safari suspends media loading while backgrounded; on return the <video> is
  // paused and stalled at a stale position (the live window has rolled past
  // what's buffered), so it can't resume on its own — the user had to refresh.
  // This nudges it back to the live edge, which is what a refresh did.
  useEffect(() => {
    function onForeground() {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (!isHlsRef.current || !isPlayingRef.current) return;
      const el = video.current;
      if (!el) return;

      const inst = hls.current;
      if (inst) {
        // hls.js path (Android Chrome / desktop): restart the loader, which
        // re-fetches the playlist and catches back up to the live edge.
        try { inst.startLoad(); } catch { /* destroyed mid-call — ignore */ }
        el.play().catch(() => {});
        return;
      }

      // Native HLS (iOS Safari). Try a plain resume first — a short background
      // often recovers without a rebuffer. If it's still stalled shortly after,
      // re-source to snap to the live edge (the manual-refresh path).
      const before = el.currentTime;
      el.play().catch(() => {});
      if (resumeTimer.current) clearTimeout(resumeTimer.current);
      resumeTimer.current = setTimeout(() => {
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        if (!isPlayingRef.current) return;
        const stalled = el.paused || el.currentTime === before;
        const url = current?.episode.enclosureUrl;
        if (stalled && url) {
          el.src = url;
          el.load();
          el.play().catch(() => {});
        }
      }, 1500);
    }

    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('focus', onForeground);
    return () => {
      document.removeEventListener('visibilitychange', onForeground);
      window.removeEventListener('focus', onForeground);
      if (resumeTimer.current) { clearTimeout(resumeTimer.current); resumeTimer.current = null; }
    };
  }, [current?.episode.enclosureUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // PiP applies to the <video> path (HLS stream or a video alternateEnclosure);
  // recompute when the item OR the audio/video mode changes. The <video> is
  // always mounted (in the portal) so video.current is live here.
  useEffect(() => {
    setPipOk(isVideo && pipSupported(video.current));
  }, [isVideo, current?.episode.id]);

  function requestPip() {
    void togglePip(video.current);
  }

  // Media Session — OS lock-screen / notification transport + metadata. Wires
  // the system media controls to the same store actions the in-app UI uses, so
  // play/pause/skip and (for podcasts) lock-screen scrubbing work with the
  // screen off. Handlers read from the store via getState so this runs once.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const seekActive = (t: number) => {
      const el = isVideoRef.current ? video.current : audio.current;
      if (el) el.currentTime = t;
      lastTick.current = Math.floor(t);
      setPosition(t);
    };
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => setPlaying(true)],
      ['pause', () => setPlaying(false)],
      ['previoustrack', () => useApp.getState().playPrev()],
      ['nexttrack', () => useApp.getState().playNext()],
      ['seekbackward', (d) => seekActive(Math.max(0, useApp.getState().positionSec - (d.seekOffset || 10)))],
      ['seekforward', (d) => seekActive(useApp.getState().positionSec + (d.seekOffset || 10))],
      ['seekto', (d) => { if (d.seekTime != null) seekActive(d.seekTime); }],
    ];
    for (const [action, handler] of handlers) {
      try { ms.setActionHandler(action, handler); } catch { /* unsupported action — skip */ }
    }
    return () => {
      for (const [action] of handlers) {
        try { ms.setActionHandler(action, null); } catch { /* skip */ }
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Single chapters fetch for the whole player — passed down to <FullscreenPlayer>
  // so it isn't fetched twice. No-ops on an empty url (music/live/no tag). Above
  // the early return (and the lock-screen metadata effect below, which reads the
  // active chapter's art) for hook order.
  const { chapters, loading: chaptersLoading } = useChapters(chapterUrlFor(current));

  // Metadata for the lock-screen / notification (title, podcast, artwork). Art
  // tracks the active chapter (Podcasting 2.0 chapters `img`) so the OS surface
  // stays in sync with the in-app now-playing art. Depends on the derived image
  // string — not positionSec — so it only re-runs when the chapter art changes,
  // not every 1 Hz position tick.
  const activeChapterImg = chapterState(chapters, positionSec, duration).chapter?.img;
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    if (!current) { navigator.mediaSession.metadata = null; return; }
    const { episode, podcast } = current;
    const art = activeChapterImg || episode.image || podcast.image || podcast.artwork;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: episode.title,
      artist: podcast.title,
      album: podcast.title,
      artwork: art ? [{ src: art }] : undefined,
    });
  }, [current?.episode.id, activeChapterImg]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reflect play/pause to the OS so the lock-screen button shows the right state.
  useEffect(() => {
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }
  }, [isPlaying]);

  // Lock-screen scrub bar. Skipped for live streams (no finite duration).
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    if (typeof navigator.mediaSession.setPositionState !== 'function') return;
    if (!duration || !isFinite(duration)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.min(positionSec, duration),
        playbackRate: 1,
      });
    } catch { /* invalid state (e.g. position > duration mid-seek) — skip */ }
  }, [positionSec, duration]);

  // Single transcript fetch for the whole player — passed down to
  // <FullscreenPlayer>. Mirrors the chapters fetch (no-ops when there's no
  // transcript / on music / live). Above the early return for hook order.
  const transcriptSrc = transcriptSourceFor(current);
  const { cues: transcriptCues, loading: transcriptLoading } = useTranscript(
    transcriptSrc.url,
    transcriptSrc.type,
  );

  if (!current) return null;
  const { episode, podcast } = current;
  const hasValue = hasValueRecipients(episode.value);
  const isLive = episode.liveStatus === 'live';

  const { index: activeIdx, chapter: activeChapter, end: activeChapterEnd } = chapterState(
    chapters,
    positionSec,
    duration,
  );

  function seekMedia(v: number) {
    const el = isVideoRef.current ? video.current : audio.current;
    if (el) el.currentTime = v;
    lastTick.current = Math.floor(v);
    setPosition(v);
  }
  const chapterNav = buildChapterNav(chapters, activeIdx, positionSec, seekMedia);
  const transcriptActiveIdx = transcriptIndexAt(transcriptCues, positionSec);

  function onMediaError(code: number | undefined) {
    // Fired by the <video> too, so name the right medium.
    const what = isHlsRef.current ? 'live stream' : isVideoRef.current ? 'video' : 'audio';
    setAudioErr(
      code === 2 ? `network error while loading ${what}`
      : code === 3 ? `${what} failed to decode`
      : code === 4 ? `${what} format not supported or URL unreachable`
      : `${what} playback failed`,
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
            // A video alternateEnclosure has a finite duration (unlike a live HLS
            // stream, whose duration is Infinity) — feed the seek bar. Guard on
            // isFinite so a live stream doesn't set a bogus duration.
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              if (isFinite(d)) setDuration(d);
              setAudioErr(null);
            }}
            // Progressive video (a podcast video rendition) just stops at the end;
            // live HLS never fires this. Music auto-advance stays on the <audio>.
            onEnded={() => setPlaying(false)}
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
          onError={(e) => { if (!isVideoRef.current) onMediaError(e.currentTarget.error?.code); }}
        />
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-4">
          {isVideo ? (
            <div className="w-12 h-12 flex-shrink-0 bg-black overflow-hidden border border-bone/20">
              {videoNode && !playerExpanded && <OutPortal node={videoNode} />}
            </div>
          ) : (activeChapter?.img || episode.image) ? (
            // Prefer the active chapter's artwork (Podcasting 2.0 chapters `img`),
            // falling back to the episode cover on a missing/broken chapter image.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={activeChapter?.img || episode.image}
              alt=""
              onError={(e) => {
                if (episode.image && e.currentTarget.src !== episode.image)
                  e.currentTarget.src = episode.image;
              }}
              className="w-12 h-12 object-cover border border-bone/20 flex-shrink-0"
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-display leading-tight truncate">{episode.title}</div>
            <div className="text-[11px] text-muted truncate">{podcast.title}</div>
            {/* The error is the one line the user actually needs to read when
                playback dies — wrap it (break-words), never truncate it. */}
            {audioErr && (
              <div className="text-[11px] text-nostr mt-1 break-words">⚠ {audioErr}</div>
            )}
            {isLive ? (
              <div className="flex items-center gap-2 mt-1">
                <span className="stamp text-nostr border-nostr/60 bg-nostr/10 animate-bolt">● LIVE</span>
                <span className="text-[10px] text-muted">streaming now</span>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 mt-1" onClick={(e) => e.stopPropagation()}>
                  <span className="text-[10px] text-muted tabular-nums">{fmt(positionSec)}</span>
                  <div className="relative flex-1 flex items-center">
                    <ChapterTicks chapters={chapters} duration={duration} />
                    <input
                      type="range"
                      className="seek block w-full relative"
                      min={0}
                      max={duration || 0}
                      value={positionSec}
                      onChange={(e) => seekMedia(Number(e.target.value))}
                    />
                  </div>
                  <span className="text-[10px] text-muted tabular-nums">{fmt(duration)}</span>
                </div>
                <ChapterLabel
                  chapter={activeChapter}
                  end={activeChapterEnd}
                  className="text-[10px] mt-0.5"
                />
              </>
            )}
          </div>
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <TransportControls playOnly={isLive} prev={chapterNav?.prev} next={chapterNav?.next} />
            <VideoToggle />
            {pipOk && (
              <button
                onClick={requestPip}
                className="btn-ghost px-2"
                title="Picture-in-Picture"
                aria-label="Picture-in-Picture"
              >
                <PipIcon />
              </button>
            )}
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
        onSeek={seekMedia}
        videoNode={videoNode}
        isVideo={isVideo}
        audioErr={audioErr}
        pipAvailable={pipOk}
        onPip={requestPip}
        chapters={chapters}
        chaptersLoading={chaptersLoading}
        transcriptCues={transcriptCues}
        transcriptLoading={transcriptLoading}
        transcriptActiveIdx={transcriptActiveIdx}
        hasTranscriptUrl={!!transcriptSrc.url}
        onClose={() => setPlayerExpanded(false)}
        onBoost={() => setBoostOpen(true)}
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
