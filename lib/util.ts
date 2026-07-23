import type { Podcast, ValueBlock, Episode, AlternateEnclosure } from './types';

// True when the feed is a Podcasting 2.0 music album (`<podcast:medium>music`).
// Case-insensitive — PI doesn't normalize the tag. Drives album-specific UI
// (play overlay, track list, row-tap-to-play, track-order sort).
export function isMusicMedium(podcast: Pick<Podcast, 'medium'>): boolean {
  return podcast.medium?.toLowerCase() === 'music';
}

// True when a value block actually has payees — the gate for showing BOOST.
export function hasValueRecipients(value?: ValueBlock | null): boolean {
  return !!value?.recipients?.length;
}

// FNV-1a hash → a stable non-negative 31-bit integer, for deterministic numeric
// IDs (e.g. synthesizing an Episode.id from a guid) that survive reloads.
export function fnvHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0x7fffffff;
}

// True when an enclosure URL is an HLS playlist (`.m3u8`). HLS needs hls.js
// (or native Safari support) and a <video> surface — not the native <audio>
// element the rest of the app uses. Nostr live streams (kind:30311) carry HLS
// URLs in their `streaming` tag.
export function isHlsUrl(url: string | undefined | null): boolean {
  return !!url && /\.m3u8(\?|#|$)/i.test(url);
}

// Whether an alternate enclosure is a video rendition. Covers progressive video
// (`video/mp4`, `video/webm`), HLS delivered with an mpegurl content type
// (`application/x-mpegurl` / `application/vnd.apple.mpegurl` — Fountain uses this
// for some video feeds), and an untyped `.m3u8` source. Excludes anything
// explicitly tagged `audio/…`.
function isVideoAlternate(a: AlternateEnclosure): boolean {
  if (!a.source) return false;
  const t = a.type?.toLowerCase() ?? '';
  if (t.startsWith('audio/')) return false;
  if (t.startsWith('video/') || t.includes('mpegurl')) return true;
  // No (or an unhelpful) type — infer from the source URL: an HLS playlist or a
  // known video container extension. Guards feeds that under-tag their <source>.
  if (!t.startsWith('image/') && !t.startsWith('text/')) {
    return isHlsUrl(a.source) || /\.(mp4|m4v|mov|webm|mkv|ogv)(\?|#|$)/i.test(a.source);
  }
  return false;
}

// The best video <podcast:alternateEnclosure> for an episode, or undefined when
// there's no video rendition. Prefers the publisher's `default`, then the
// highest-resolution variant, then the first listed. Drives the "Video" toggle
// in the player — a video rendition plays through the shared <video> element the
// HLS path already uses (progressive video plays natively; HLS via hls.js).
export function pickVideoAlternate(ep: Pick<Episode, 'alternateEnclosures'>): AlternateEnclosure | undefined {
  const videos = ep.alternateEnclosures?.filter(isVideoAlternate);
  if (!videos?.length) return undefined;
  return (
    videos.find((a) => a.default) ??
    [...videos].sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]
  );
}

// Picture-in-Picture across the two web APIs: the standard `requestPictureInPicture`
// (Android Chrome, desktop Chrome/Edge/Firefox/Safari) and WebKit's
// `webkitSetPresentationMode` (iOS Safari, which doesn't implement the standard
// one). Only matters for the HLS <video> path — the native <audio> the rest of
// the app uses can't go into PiP. PiP also keeps a stream's audio playing while
// the app is backgrounded on mobile, so it doubles as background audio for video.
type WebkitVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
};

export function pipSupported(el: HTMLVideoElement | null): boolean {
  if (!el || typeof document === 'undefined') return false;
  if (document.pictureInPictureEnabled && !el.disablePictureInPicture) return true;
  const w = el as WebkitVideo;
  return (
    typeof w.webkitSupportsPresentationMode === 'function' &&
    w.webkitSupportsPresentationMode('picture-in-picture')
  );
}

// Toggle PiP for the given <video>. Prefers the standard API, falls back to
// WebKit. Swallows errors (a missing user gesture / not-allowed throws and is
// not worth surfacing).
export async function togglePip(el: HTMLVideoElement | null): Promise<void> {
  if (!el || typeof document === 'undefined') return;
  if (document.pictureInPictureEnabled && !el.disablePictureInPicture) {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await el.requestPictureInPicture();
    } catch { /* user gesture / not-allowed — silent */ }
    return;
  }
  const w = el as WebkitVideo;
  if (typeof w.webkitSetPresentationMode === 'function') {
    try {
      w.webkitSetPresentationMode(
        w.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture',
      );
    } catch { /* silent */ }
  }
}

// Coerce an unknown thrown value into a user-readable string. Use for the
// fallback in `catch (e) { return { error: getErrorMessage(e, '<x> failed') } }`
// patterns in API routes and UI handlers.
export function getErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return fallback;
}

// Strip HTML tags and entity-decode. Used by server components (lib/format.tsx
// is 'use client' so can't be imported on the server side). Pure string regex,
// no DOM required — isomorphic.
export function stripHtml(s: string): string {
  return s
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
