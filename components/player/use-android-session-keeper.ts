'use client';

import { useEffect } from 'react';
import { logPlayback } from '@/lib/playback-log';

/**
 * ANDROID ONLY: a silent, looping `<audio>` that plays while the store says
 * playing, so the lock-screen player does not vanish at every track change.
 *
 * Reported from Chad's Android phone on 2026-11-14 (the Boost Me Buddy
 * Zapstore app, a favorites shuffle): the lock-screen player disappeared for
 * a moment at each track change — ⏭ and a song ending alike — and came back
 * when the next song started.
 *
 * WHY: Chrome's lock-screen and notification player belongs to the page's
 * media SESSION, and the session is active only while it holds a player.
 * `<Player>` plays every track through one `<audio>`, and a new `src` makes
 * Chrome destroy the media player behind it and create another (measured
 * over CDP: `kWebMediaPlayerDestroyed`, then a new player id). A track that
 * ENDS leaves the session even before that. Until the next file plays, the
 * session holds no player, and Android removes the lock-screen player.
 *
 * So a second player stays in the session across the gap. Three rules:
 * - **It follows `isPlaying`, never the element.** A track change keeps
 *   `isPlaying` true (the shuffle, Up Next and an album all step with
 *   `isPlaying: true`), so the keeper plays straight through it, and a pause
 *   pauses it — or the lock screen would draw ❚❚ over a paused app.
 * - **Longer than 5 s.** Chrome counts shorter media as a ONE-SHOT player
 *   (`kMinimumDurationForContentSecs`), and a session that holds one is not
 *   controllable: the lock-screen buttons go dead. The loop is 10 s.
 * - **Not in the document.** A detached element's events never reach the
 *   document's capture listeners, so it writes no `m.*` lines to the playback
 *   log and does not trigger `useMediaSession`'s handler hand-over.
 *
 * The page sets `setPositionState`, `playbackState` and every action handler,
 * so Chrome takes the position and the buttons from the PAGE, not from either
 * player; a second player does not change the seek bar or the controls.
 *
 * Not on iOS, where this fault was not seen and where a second element is a
 * risk to background play (#555), and not on a desktop.
 */
const KEEPER_SECONDS = 10;
const RATE = 8000;

let keeper: HTMLAudioElement | null = null;

/** 8-bit mono PCM, where 128 is silence. 80 KB, built once, never fetched. */
function silentWav(seconds: number): Blob {
  const n = RATE * seconds;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF'); v.setUint32(4, 36 + n, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  ascii(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  return new Blob([buf], { type: 'audio/wav' });
}

function keeperElement(): HTMLAudioElement {
  if (!keeper) {
    keeper = new Audio(URL.createObjectURL(silentWav(KEEPER_SECONDS)));
    keeper.loop = true;
    keeper.preload = 'auto';
  }
  return keeper;
}

function onAndroid(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

export function useAndroidSessionKeeper(isPlaying: boolean): void {
  useEffect(() => {
    if (!onAndroid()) return;
    const el = keeperElement();
    if (isPlaying) {
      if (!el.paused) return;
      el.play().then(
        () => logPlayback('keeper', { on: 1 }),
        // A refusal costs only the fix: the lock screen gaps as it did before.
        (e: unknown) => logPlayback('keeper', { on: 0, err: e instanceof Error ? e.name : 'unknown' }),
      );
    } else if (!el.paused) {
      el.pause();
      logPlayback('keeper', { on: 0 });
    }
  }, [isPlaying]);

  // `<Player>` lives in the root layout, so this runs at a page unload or a
  // dev remount; a keeper left playing would hold the session on its own.
  useEffect(() => () => { keeper?.pause(); }, []);
}
