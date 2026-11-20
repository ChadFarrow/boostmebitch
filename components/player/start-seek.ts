'use client';

import { logPlayback } from '@/lib/playback-log';

/** The chances a new source gets to land on its start position. */
const SEEK_EVENTS = ['loadedmetadata', 'canplay', 'play', 'playing'] as const;
/** Close enough to count as there: a seek lands on a packet, not the second. */
const LANDED_SEC = 2;
/** `HTMLMediaElement.HAVE_METADATA`: below it a seek has no timeline to land on. */
const HAVE_METADATA = 1;

/**
 * Put a NEW source at its start position — once it PLAYS, never before — and
 * check again until it has. `<Player>`'s audio AND video branches both call
 * this, once per source; the return value disarms it, and each branch's
 * effect cleanup calls it.
 *
 * **NEVER SEEK A PAUSED ELEMENT HERE — the iPhone loses that seek, and then
 * LIES about it.** Measured on 2026-11-20 (iPhone 11, iOS 27.2.1, Safari):
 * after a reopen the episode came back paused at its saved 1:40, the player
 * seeked it at `loadedmetadata` (readyState 1, nothing buffered — iOS loads no
 * media data until play), and WebKit never finished that seek: no `seeked`,
 * `currentTime` read 100 at every event after it, ▶ played the SOUND from
 * 0:00, `playing` never fired, and the bar sat at 1:40. Its playback log:
 *   m.loadedmetadata el=a rs=1 ct=0 paused=1
 *   seek.start el=a ev=loadedmetadata from=0 to=100
 *   m.play el=a rs=1 ct=100 paused=0
 *   m.canplay el=a rs=3 ct=100 paused=0      (no m.seeked, no m.playing)
 * Because the element reports the target, no check that reads `currentTime`
 * can see the failure afterwards — a first version of this helper re-checked
 * at `canplay`, read 100, and called it landed. The fix is to not cause it: a
 * restart, a cue and a revealed queue head all attach their source PAUSED,
 * and the seek now waits for `play`. A seek made while the element plays is
 * what #485 verified on that iPhone (AUDIO → VIDEO mid-episode).
 *
 * **ONE SEEK IS NOT ENOUGH EITHER.** Safari can accept an assignment and still
 * start at 0:00 (#485), so while the element plays the start is re-checked at
 * `loadedmetadata`, `canplay`, `play` and `playing` — whichever come — and
 * re-applied while it is short. It stops for good once it has landed, after
 * `playing` (the last chance before the listener hears the wrong place), or at
 * the first `seeking` it did not cause: a scrub, a chapter tap or the
 * lost-buffer restore is somebody else's instruction, and wins — including one
 * made while the episode sits paused waiting for ▶. `startAt <= 0` (a fresh
 * play, a live item) arms nothing.
 *
 * The audio branch kept a single `{ once: true }` seek at `loadedmetadata`
 * until 2026-11-20 and the video branch had the re-checks; the two had
 * drifted, and this is the one copy. Each seek it makes writes a `seek.start`
 * line to the playback log — the event, where the element was (`from`) and
 * where it was sent (`to`), in whole seconds — the one witness a phone-only
 * fault leaves in a bug report.
 */
export function armStartSeek(el: HTMLMediaElement, startAt: number, tag: 'a' | 'v'): () => void {
  let landed = !(startAt > 0);
  let ours = false;
  const done = () => {
    landed = true;
    for (const ev of SEEK_EVENTS) el.removeEventListener(ev, seekToStart);
    el.removeEventListener('seeking', onSeeking);
  };
  function seekToStart(e: Event) {
    if (landed) return;
    // Paused, or no timeline yet: wait for the next event, which `play` brings.
    if (el.paused || el.readyState < HAVE_METADATA) return;
    if (Math.abs(el.currentTime - startAt) < LANDED_SEC) return done();
    ours = true;
    logPlayback('seek.start', { el: tag, ev: e.type, from: Math.floor(el.currentTime || 0), to: Math.floor(startAt) });
    el.currentTime = startAt;
    if (e.type === 'playing') done();
  }
  function onSeeking() {
    if (ours) { ours = false; return; }
    done();
  }
  if (!landed) {
    for (const ev of SEEK_EVENTS) el.addEventListener(ev, seekToStart);
    el.addEventListener('seeking', onSeeking);
  }
  return done;
}
