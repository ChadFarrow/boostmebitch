'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { gifPickKey, type GifTile } from '@/lib/gifs/pick';
import { alphaSrc, borrowVideo, canPlayH264, returnVideo } from '@/lib/gifs/video-pool';

// The GIF picker's grid: every GIF near the screen holds a pooled <video> and
// plays while it is on screen. The rules are nostr.build's, measured on Safari
// (https://gifs.nostr.build/developers/grid.md) — read "Why GIF grids freeze
// phones" there before changing what a tile loads or when:
//
//   far (outside half a box-height)  → its blurred placeholder only; asks for nothing
//   near for 150 ms                  → borrows a video, `src` + `#t=0.001`, paused on frame one
//   a tenth on screen                → plays
//   off screen, still near           → pauses (only if playing)
//   out of near, or unmounted        → the video goes back to the pool, emptied
//
// Fallbacks, in order: video (a transparent GIF's own file, then its MP4) →
// the animated preview → the still. Reduced motion, or a `play()` refused with
// `NotAllowedError`, gives stills for the whole grid (`motion: 'still'`).

const COLUMNS = 2;
/** A fling passes a tile in less than this, so it loads nothing. */
const NEAR_DELAY_MS = 150;
/** Height ÷ width, clamped to 2:1 … 3:4, so no tile is a sliver or a tower. */
const MIN_RATIO = 1 / 2;
const MAX_RATIO = 4 / 3;
const FADE_MS = 150;

export type GridMotion = 'play' | 'still';

function ratioOf(t: GifTile): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, t.height / t.width));
}

type ZoneHandler = { near: (inside: boolean) => void; onScreen: (inside: boolean) => void };
type Zones = { watch: (el: Element, h: ZoneHandler) => () => void };

/**
 * Two observers for the whole grid, rooted at the picker's scroll box — in a
 * dialog the grid scrolls its own element, not the page, so "near" and "on
 * screen" have to be measured against what the reader sees.
 */
function useZones(root: HTMLElement | null): Zones | null {
  const handlers = useRef(new Map<Element, ZoneHandler>());
  const [zones, setZones] = useState<Zones | null>(null);
  useEffect(() => {
    if (!root || typeof IntersectionObserver === 'undefined') return;
    const map = handlers.current;
    const near = new IntersectionObserver(
      (entries) => { for (const e of entries) map.get(e.target)?.near(e.isIntersecting); },
      { root, rootMargin: '50% 0px' },
    );
    const onScreen = new IntersectionObserver(
      (entries) => { for (const e of entries) map.get(e.target)?.onScreen(e.isIntersecting && e.intersectionRatio >= 0.1); },
      { root, threshold: [0, 0.1] },
    );
    setZones({
      watch(el, h) {
        map.set(el, h);
        near.observe(el);
        onScreen.observe(el);
        return () => { near.unobserve(el); onScreen.unobserve(el); map.delete(el); };
      },
    });
    return () => { near.disconnect(); onScreen.disconnect(); map.clear(); setZones(null); };
  }, [root]);
  return zones;
}

export function GifGrid({
  tiles,
  scrollRoot,
  motion,
  onAutoplayRefused,
  onPick,
  disabled,
}: {
  tiles: GifTile[];
  scrollRoot: HTMLElement | null;
  motion: GridMotion;
  onAutoplayRefused: () => void;
  onPick: (tile: GifTile) => void;
  disabled: boolean;
}) {
  const zones = useZones(scrollRoot);
  // Masonry, in result order: each GIF under the shorter column, so the best
  // results fill the top row rather than running down the first column.
  const columns = useMemo(() => {
    const cols: GifTile[][] = Array.from({ length: COLUMNS }, () => []);
    const heights = new Array<number>(COLUMNS).fill(0);
    for (const tile of tiles) {
      const c = heights.indexOf(Math.min(...heights));
      cols[c].push(tile);
      heights[c] += ratioOf(tile);
    }
    return cols;
  }, [tiles]);
  // One pick per opening: a second tap during the close must not add a second GIF.
  const picked = useRef(false);
  const h264 = useMemo(() => canPlayH264(), []);

  return (
    <div className="flex gap-2">
      {columns.map((col, i) => (
        <div key={i} className="flex min-w-0 flex-1 flex-col gap-2">
          {col.map((tile) => (
            <Tile
              key={gifPickKey(tile.pick)}
              tile={tile}
              zones={zones}
              motion={motion}
              h264={h264}
              onAutoplayRefused={onAutoplayRefused}
              disabled={disabled}
              onPick={() => {
                if (picked.current) return;
                picked.current = true;
                onPick(tile);
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Where a tile is in its fallback chain. */
type Stage = 'alpha' | 'mp4' | 'animated' | 'still';

function Tile({
  tile,
  zones,
  motion,
  h264,
  onAutoplayRefused,
  onPick,
  disabled,
}: {
  tile: GifTile;
  zones: Zones | null;
  motion: GridMotion;
  h264: boolean;
  onAutoplayRefused: () => void;
  onPick: () => void;
  disabled: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const holder = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  const [armed, setArmed] = useState(false); // near for NEAR_DELAY_MS
  const [onScreen, setOnScreen] = useState(false);
  const [onScreenLong, setOnScreenLong] = useState(false); // on screen for NEAR_DELAY_MS
  const alpha = alphaSrc(tile.alpha);
  const [stage, setStage] = useState<Stage>(() => (alpha ? 'alpha' : h264 ? 'mp4' : 'animated'));
  // A NEW object per borrow, not the element: the pool often hands the same
  // element straight back (a WebM that fails → its MP4), and a play effect
  // keyed on the element alone would then never run for the new source.
  const [video, setVideo] = useState<{ el: HTMLVideoElement } | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [faded, setFaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [played, setPlayed] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  // Read in effects without making them depend on a new function each render.
  const refused = useRef(onAutoplayRefused);
  refused.current = onAutoplayRefused;
  const onScreenRef = useRef(onScreen);
  onScreenRef.current = onScreen;

  useEffect(() => {
    const el = button.current;
    if (!zones || !el) return;
    return zones.watch(el, { near: setNear, onScreen: setOnScreen });
  }, [zones]);

  useEffect(() => {
    if (!near) { setArmed(false); return; }
    const t = setTimeout(() => setArmed(true), NEAR_DELAY_MS);
    return () => clearTimeout(t);
  }, [near]);

  useEffect(() => {
    if (!onScreen) { setOnScreenLong(false); return; }
    const t = setTimeout(() => setOnScreenLong(true), NEAR_DELAY_MS);
    return () => clearTimeout(t);
  }, [onScreen]);

  const videoSrc = motion === 'play' && armed
    ? stage === 'alpha' ? alpha : stage === 'mp4' ? tile.mp4 : null
    : null;

  // Borrow on arming, return on leaving near, on a fallback, and on unmount.
  // Keyed on the src ONLY, so a re-render never empties and reloads a video.
  useEffect(() => {
    const host = holder.current;
    if (!videoSrc || !host) return;
    const v = borrowVideo();
    let fadeTimer: ReturnType<typeof setTimeout> | undefined;
    const onLoaded = () => {
      setDrawn(true);
      // A frame that comes up out of view shows at once; on screen it fades in,
      // and the placeholder goes only when the fade ends (a transparent GIF:
      // as it starts, or the placeholder shows through it the whole time).
      const fade = onScreenRef.current;
      v.style.transition = fade ? `opacity ${FADE_MS}ms` : 'none';
      v.style.opacity = '1';
      if (!fade || tile.alpha) setFaded(true);
      else fadeTimer = setTimeout(() => setFaded(true), FADE_MS + 20);
    };
    const onError = () => setStage((s) => (s === 'alpha' ? (h264 ? 'mp4' : 'animated') : 'animated'));
    const onPlaying = () => { setPlaying(true); setPlayed(true); };
    const onPause = () => setPlaying(false);
    v.addEventListener('loadeddata', onLoaded);
    v.addEventListener('error', onError);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('pause', onPause);
    v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;opacity:0';
    v.autoplay = false; // Chrome starts a waiting video by itself with autoplay on, even off screen.
    v.src = `${videoSrc}#t=0.001`; // Safari draws nothing for a paused video without this.
    host.appendChild(v);
    setVideo({ el: v });
    return () => {
      clearTimeout(fadeTimer);
      v.removeEventListener('loadeddata', onLoaded);
      v.removeEventListener('error', onError);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('pause', onPause);
      returnVideo(v);
      setVideo(null);
      setDrawn(false);
      setFaded(false);
      setPlaying(false);
    };
  }, [videoSrc, tile.alpha, h264]);

  // Play a tenth on screen; pause (only if playing) once off it.
  useEffect(() => {
    if (!video) return;
    const el = video.el;
    if (onScreen) {
      el.autoplay = true;
      el.play().catch((e: unknown) => {
        // A refusal (iOS Low Power Mode) holds for the whole grid until the
        // next search. An AbortError only means we paused it.
        if ((e as { name?: string })?.name === 'NotAllowedError') refused.current();
      });
    } else {
      el.autoplay = false;
      if (!el.paused) el.pause();
    }
  }, [video, onScreen]);

  const still = motion === 'still' || stage === 'still' || (stage === 'animated' && imgFailed);
  // The animated preview is an <img> — the WebKit thread trap — so only where
  // no video can play, and only after 150 ms on screen.
  const imgSrc = !armed
    ? null
    : still
      ? tile.still
      : stage === 'animated' && onScreenLong
        ? tile.animated
        : null;
  const state = !armed
    ? 'far'
    : still
      ? 'still'
      : stage === 'animated'
        ? 'preview'
        : playing
          ? 'playing'
          : played
            ? 'paused'
            : 'waiting';
  const pictured = drawn || !!imgSrc;

  return (
    <button
      ref={button}
      type="button"
      data-gif-key={gifPickKey(tile.pick)}
      data-state={state}
      aria-label={tile.title || 'GIF'}
      title={tile.title || 'GIF'}
      disabled={disabled}
      onClick={onPick}
      className={`group relative block w-full overflow-hidden rounded border border-line focus-visible:outline-none disabled:opacity-40 [@media(hover:hover)]:hover:border-bolt ${pictured ? 'bg-transparent' : 'bg-bone/5'}`}
      style={{ aspectRatio: `1 / ${ratioOf(tile)}` }}
    >
      {tile.lqip && !faded && !(imgSrc && !still) && (
        <span
          aria-hidden
          data-lqip=""
          className="absolute inset-0 bg-cover bg-center"
          // Validated as `data:image/(webp|png|jpeg);base64,…` (lib/gifs/nostr-build.ts),
          // so it cannot close the url() and inject CSS.
          style={{ backgroundImage: `url("${tile.lqip}")` }}
        />
      )}
      <span ref={holder} aria-hidden className="absolute inset-0 rounded-[inherit]" />
      {imgSrc && (
        // eslint-disable-next-line @next/next/no-img-element -- third-party media; next/image would re-encode it
        <img
          src={imgSrc}
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => (imgSrc === tile.animated ? setImgFailed(true) : undefined)}
        />
      )}
      {/* The focus ring INSIDE the tile, drawn over the video: a ring outside is
          cut off by the scroll box and covered by the next tile. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[inherit] group-focus-visible:shadow-[inset_0_0_0_2px_rgb(var(--bolt))]"
      />
    </button>
  );
}
