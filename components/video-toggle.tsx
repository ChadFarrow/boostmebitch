'use client';
import { useApp } from '@/lib/store';
import { isHlsUrl, pickVideoAlternate } from '@/lib/util';

// Audio ⇄ Video toggle, shown only when the current item carries a video
// <podcast:alternateEnclosure>. Store-driven (videoMode), so the mini-player and
// the fullscreen player render the same state and stay in sync. Hidden when the
// enclosure is already an HLS video (a live stream — no audio-only rendition to
// switch to). Switching preserves the current playback position (<Player> re-
// sources the media element and seeks back to positionSec).
export function VideoToggle({ className = '' }: { className?: string }) {
  const current = useApp((s) => s.current);
  const videoMode = useApp((s) => s.videoMode);
  const setVideoMode = useApp((s) => s.setVideoMode);

  if (!current) return null;
  // Already video (HLS live stream) — nothing to toggle.
  if (isHlsUrl(current.episode.enclosureUrl)) return null;
  if (!pickVideoAlternate(current.episode)) return null;

  return (
    <button
      type="button"
      onClick={() => setVideoMode(!videoMode)}
      className={`btn-ghost px-2 ${className}`}
      title={videoMode ? 'Switch to audio' : 'Watch the video version'}
      aria-pressed={videoMode}
    >
      {videoMode ? '🎧 Audio' : '📺 Video'}
    </button>
  );
}
