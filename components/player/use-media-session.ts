'use client';

import { useEffect, useState, type RefObject } from 'react';
import { useApp } from '@/lib/store';
import { artCandidates } from '@/lib/util';
import type { Episode, Podcast } from '@/lib/types';

/**
 * How long the now-playing artwork must hold still before the lock screen is
 * told about it. See the settle effect below for why this exists at all.
 */
const LOCK_ART_SETTLE_MS = 3000;

interface Args {
  /** The active item, or null when nothing is loaded. */
  current: { episode: Episode; podcast: Podcast } | null;
  isPlaying: boolean;
  positionSec: number;
  /** Element duration. Infinity on a live stream, NaN before metadata lands. */
  duration: number;
  /** Current artwork per `nowPlayingArt` — live, i.e. changes on every chapter. */
  nowArt: string | undefined;
  audio: RefObject<HTMLAudioElement | null>;
  video: RefObject<HTMLVideoElement | null>;
  /** Whether the video element is the active one, read as a ref so an episode
   *  switch doesn't re-register handlers. */
  isVideoRef: RefObject<boolean>;
  /** Player's own "last whole second emitted" tracker, kept in sync on seeks. */
  lastTick: RefObject<number>;
  setPosition: (t: number) => void;
  setPlaying: (v: boolean) => void;
  /** RELATIVE jump, clamped — shared with the in-app skip buttons. */
  skipBy: (deltaSec: number) => void;
}

/**
 * The OS lock-screen / notification integration: transport handlers, play state,
 * scrub bar, and metadata.
 *
 * Extracted from <Player> as a unit because these four effects and the one piece
 * of state between them are entirely about Media Session and touch nothing else
 * in the player except its element refs. The rest of <Player> — the source
 * effect, the artwork gate, the HLS path, the iOS foreground resume — is
 * deliberately NOT here: those are entangled with each other and with playback
 * correctness in ways a mechanical extraction would obscure.
 */
export function useMediaSession({
  current, isPlaying, positionSec, duration, nowArt,
  audio, video, isVideoRef, lastTick,
  setPosition, setPlaying, skipBy,
}: Args): void {
  const episodeId = current?.episode.id;

  // Wires the system media controls to the same store actions the in-app UI
  // uses, so play/pause/skip and (for podcasts) lock-screen scrubbing work with
  // the screen off. Handlers read from the store via getState so this runs once.
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
      // Through `skipBy`, not `seekActive` + `getState().positionSec`: these are
      // RELATIVE jumps and had the same stale-base bug the in-app buttons would
      // have had — hold down the lock-screen skip and every repeat recomputed
      // from the same ~4Hz-old position, so a run of them moved one interval.
      // `seekto` below stays on `seekActive`, because it is absolute.
      ['seekbackward', (d) => skipBy(-(d.seekOffset || 10))],
      ['seekforward', (d) => skipBy(d.seekOffset || 10)],
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

  // The lock screen follows the chapter too — but it is handed a SETTLED url,
  // never the live one.
  //
  // A MediaMetadata artwork fetch is not an <img>. The browser issues it on our
  // behalf: it takes no `fetchPriority`, `loading="lazy"` means nothing to it,
  // and it is NOT cancelled when the next chapter supersedes it — replacing the
  // metadata just adds a second fetch to the first one's queue. Homegrown Hits
  // ep. 146 carries chapter art of 20–36 MB apiece beside a 175 MB mp3, much of
  // it on the audio's OWN host sharing its HTTP/2 connection, so handing the OS
  // a new one per ⏭ starved the element to readyState 1 — playing according to
  // `paused`, silent in fact. Waiting for the art to hold still means a run of
  // skips issues nothing; only the chapter someone stops on is fetched.
  //
  // The settled value carries the episode it was settled FOR. Without that, the
  // 3 s of lag becomes a correctness bug at every episode change: the metadata
  // effect re-runs immediately on the new episode while this state still holds
  // the old one's chapter art, and the lock screen shows the previous show's
  // cover under the new title — and pays for the fetch. Comparing the id makes
  // the stale value evaluate to undefined in the SAME render, so the new
  // episode's own cover goes out first and the chapter art follows once it has
  // held still.
  const [lockArt, setLockArt] = useState<{ epId?: number; url?: string }>({});
  useEffect(() => {
    const t = setTimeout(() => setLockArt({ epId: episodeId, url: nowArt }), LOCK_ART_SETTLE_MS);
    return () => clearTimeout(t);
  }, [nowArt, episodeId]);
  const settledArt = lockArt.epId === episodeId ? lockArt.url : undefined;

  // The current item's DOWNLOADED cover (a blob: URL, or null), and whether the
  // browser believes it has a network. Together they decide the one case the
  // proxied entry below cannot serve — see the OFFLINE note in the effect.
  const localCover = useApp((s) => s.nowPlayingCover);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // Metadata for the lock-screen / notification (title, podcast, artwork).
  // Re-runs on the settled art as well as the episode, and rebuilds the whole
  // MediaMetadata rather than mutating `.artwork` in place — mutation is not
  // reliably picked up once the object has been handed over.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    if (!current) { navigator.mediaSession.metadata = null; return; }
    const { episode, podcast } = current;
    const art = settledArt || episode.image || podcast.image || podcast.artwork;
    // THE PROXIED COPY, and this is the half the settle timer could not fix.
    // Holding still stopped a run of skips issuing one fetch per chapter; it
    // did nothing about the SIZE of the one fetch that is issued. Measured on
    // Mutton, Mead & Music, where two chapter covers are animated GIFs:
    // 11,555,231 bytes went out on the enclosure's own connection for a
    // lock-screen thumbnail, and no screen in this app was showing them.
    // Proxied at 1024 the same two are 151,731.
    //
    // 1024 because this is not a tile — it is what the OS paints on a lock
    // screen, which on a phone is bigger than any surface in the app.
    //
    // **ONE ENTRY, and this is the one place the "raw URL always behind the
    // proxied one" rule is inverted — on purpose.** A MediaMetadata `artwork`
    // list is not an `onError` ladder: there is no error to catch, and Chromium
    // fetches EVERY entry rather than stopping at the one it uses. Measured
    // 2026-09-21 on this episode with both entries listed: the proxied copies
    // came down (267,098 + 114,002 + 37,729) AND both originals did
    // (6,400,448 + 4,478,255). So a fallback here does not cost a retry, it
    // costs the whole file every time, which is the harm the tail exists to
    // prevent. The failure it gives up is cosmetic and off-app: if /api/art
    // cannot serve the picture, the lock screen shows none.
    const proxied = art ? artCandidates(art, null, 1024).find((u) => u !== art) : undefined;
    // OFFLINE, THE DOWNLOADED COVER — and only offline. Found on a Pixel 6 in
    // airplane mode, 2026-09-21: a download played from local bytes, both
    // in-app covers fell back to the stored cover, and the lock screen showed
    // none, because its one entry is an /api/art URL nothing can answer. The
    // stored cover is the only picture there is then, and a blob: URL is
    // accepted: measured through `dumpsys media_session`, offline, the proxied
    // entry left 4 metadata keys and the blob left 5 (the bitmap).
    //
    // Online nothing changes, on purpose: the proxied copy is w=1024 where the
    // stored one is w=640, and chapter art must still win. It outranks the
    // chapter offline because chapter art is never downloaded. The previous
    // episode's URL cannot paint the wrong cover at a change of episode:
    // <Player> revokes it in an effect cleanup, React runs every cleanup of a
    // commit before any new effect, and a revoked blob: loads nothing (the same
    // measurement: 4 keys).
    const offlineCover = !online && localCover ? localCover : undefined;
    const lockSrc = offlineCover ?? proxied ?? art;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: episode.title,
      artist: podcast.title,
      album: podcast.title,
      // `sizes` only when it IS the proxied copy: that is the one whose
      // dimensions we asked for. Stamping a third-party URL with a size nobody
      // measured turns a guess into a claim the OS picks by.
      artwork: lockSrc ? [!offlineCover && proxied ? { src: lockSrc, sizes: '1024x1024' } : { src: lockSrc }] : undefined,
    });
  }, [episodeId, settledArt, localCover, online]); // eslint-disable-line react-hooks/exhaustive-deps
}
