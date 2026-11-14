// One page-wide pool of <video> elements for the GIF picker grid.
//
// WHY A POOL (https://gifs.nostr.build/developers/grid.md, "The video pool").
// WebKit keeps a media session for every <video> until it is garbage
// collected — pausing, emptying or removing it does not end the session — and
// walks every one of them on each play and pause. With a new <video> per tile,
// each play costs more than the last; nostr.build measured CPU climbing to
// 100% over three or four searches. A pool keeps the number of sessions at the
// most videos ever in use at once. So: one pool for the page's life, shared by
// every grid, NEVER emptied — a spare video holds nothing.
//
// And why video at all: in WebKit every animated <img> keeps a decoding thread
// and its frames until the page closes, and the page freezes at 512 threads.
// A video is decoded by the media stack and lets go once emptied.

const spare: HTMLVideoElement[] = [];

/** A muted, looping, inline video with no `src`, ready to attach to a tile. */
export function borrowVideo(): HTMLVideoElement {
  const reused = spare.pop();
  if (reused) return reused;
  const v = document.createElement('video');
  // iOS plays a video by itself only while it is muted; `playsInline` keeps an
  // iPhone from going full screen. Attributes as well as properties, because
  // WebKit reads the `muted` and `playsinline` ATTRIBUTES for autoplay policy.
  v.muted = true;
  v.defaultMuted = true;
  v.loop = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.disablePictureInPicture = true;
  v.setAttribute('muted', '');
  v.setAttribute('playsinline', '');
  v.setAttribute('aria-hidden', 'true');
  // The player's lock-screen hook hears every `playing` in the document; this
  // marks a tile's so it writes no playback-log line for one
  // (components/player/use-media-session.ts).
  v.setAttribute('data-gif-tile', '');
  return v;
}

/**
 * Give a video back: paused, emptied (`load()` with no `src` drops the decoder
 * and its frames), detached. Call it BEFORE the tile leaves the page —
 * removing an element does not reliably free its media. `pause()` only when
 * playing: WebKit walks its sessions on every `pause()`, even of a paused one.
 */
export function returnVideo(v: HTMLVideoElement): void {
  if (!v.paused) v.pause();
  v.autoplay = false;
  v.removeAttribute('src');
  v.load();
  v.remove();
  v.removeAttribute('style');
  if (!spare.includes(v)) spare.push(v);
}

let h264: boolean | null = null;

/**
 * Whether this browser plays H.264, asked once. Some Linux builds of Chromium
 * and Firefox do not; there a tile shows its animated preview instead of
 * failing one video at a time.
 */
export function canPlayH264(): boolean {
  if (h264 === null) {
    try {
      h264 = document.createElement('video').canPlayType('video/mp4; codecs="avc1.4d401e"') !== '';
    } catch {
      h264 = false;
    }
  }
  return h264;
}

/**
 * The ONE file a transparent GIF plays with its transparency in this browser:
 * HEVC for WebKit (a user agent with `AppleWebKit` and no `Chrome/` — every iOS
 * browser), WebM for Chrome, Edge and Firefox, else null (play the MP4).
 * Never several `<source>`s: Safari and Firefox each report the other's format
 * as playable, then play it on black.
 */
export function alphaSrc(alpha: { webm: string | null; hevc: string | null } | null): string | null {
  if (!alpha || typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent;
  if (/AppleWebKit/.test(ua) && !/Chrome\//.test(ua)) return alpha.hevc;
  if (/Chrome\/|Firefox\//.test(ua)) return alpha.webm;
  return null;
}
