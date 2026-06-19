import type { Podcast, ValueBlock } from './types';

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
