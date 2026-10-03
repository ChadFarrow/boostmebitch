'use client';
import { useApp } from '@/lib/store';
import { canPlayNativeHlsAudio, isHlsUrl, pickVideoAlternate } from '@/lib/util';

// Segmented Audio | Video control, shown when the current item carries a video
// <podcast:alternateEnclosure>, or is an HLS live stream on a browser that
// plays HLS on the <audio> (Safari — see `canPlayNativeHlsAudio`). Store-driven
// (videoMode), so every surface renders the same state and stays in sync.
// Defaults to Audio (videoMode starts false and resets on every play), which
// for a live stream is what keeps it playing with the screen off. Elsewhere an
// HLS stream can only play on the <video>, so there is nothing to toggle.
// Switching preserves the current playback position (<Player> re-sources the
// media element and seeks back to positionSec); a live stream rejoins at the
// live edge.
//
// The caller owns the `display` utility via className (e.g. `inline-flex`, or
// `hidden sm:inline-flex` to drop it on a cramped mobile mini-bar) — the base
// class sets no display so those don't collide.
export function VideoToggle({ className = 'inline-flex' }: { className?: string }) {
  const current = useApp((s) => s.current);
  const videoMode = useApp((s) => s.videoMode);
  const setVideoMode = useApp((s) => s.setVideoMode);

  if (!current) return null;
  if (isHlsUrl(current.episode.enclosureUrl)) {
    if (!canPlayNativeHlsAudio()) return null;
  } else if (!pickVideoAlternate(current.episode)) {
    return null;
  }

  const seg = (on: boolean) =>
    `px-3 py-1.5 text-xs font-semibold uppercase tracking-widest rounded-full transition ${
      on ? 'bg-bolt text-ink shadow-sm' : 'text-bone/70 hover:text-bone'
    }`;

  return (
    <div
      role="group"
      aria-label="Play audio or video"
      className={`items-center gap-0.5 p-0.5 rounded-full border border-bone/15 bg-bone/5 ${className}`}
    >
      <button
        type="button"
        onClick={() => setVideoMode(false)}
        className={seg(!videoMode)}
        aria-pressed={!videoMode}
      >
        🎧 Audio
      </button>
      <button
        type="button"
        onClick={() => setVideoMode(true)}
        className={seg(videoMode)}
        aria-pressed={videoMode}
      >
        📺 Video
      </button>
    </div>
  );
}
