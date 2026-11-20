'use client';

import { logPlayback } from '@/lib/playback-log';

/** The three chances a new source gets to land on its start position. */
const SEEK_EVENTS = ['loadedmetadata', 'canplay', 'playing'] as const;
/** Close enough to count as there: a seek lands on a packet, not the second. */
const LANDED_SEC = 2;

/**
 * Put a NEW source at its start position, and check again until it plays.
 * `<Player>`'s audio AND video branches both call this, once per source;
 * the return value disarms it, and each branch's effect cleanup calls it.
 *
 * **ONE SEEK AT `loadedmetadata` IS NOT ENOUGH.** Safari can accept an
 * assignment there and still start at 0:00. The video branch learned it first
 * (#485, reported from an iPhone: AUDIO → VIDEO mid-episode started the
 * picture at 0:00, and three checks fixed it, verified on that iPhone). The
 * audio branch kept its single `{ once: true }` seek until 2026-11-20, when the
 * same iPhone came back from a restart with the episode in the player at 5:21,
 * ▶ started the SOUND from the top, and the bar still read 5:21. The two
 * branches had drifted; this is the one copy.
 *
 * So the start is re-checked at `loadedmetadata`, `canplay` and `playing`, and
 * re-applied while the element is short of it. It stops for good once it has
 * landed, after `playing` (the last chance before the listener hears the
 * wrong place), or at the first `seeking` it did not cause — a scrub, a
 * chapter tap or the lost-buffer restore in that window is somebody else's
 * instruction, and wins. `startAt <= 0` (a fresh play, a live item) arms
 * nothing.
 *
 * Each re-application writes a `seek.start` line to the playback log, the one
 * witness a phone-only fault leaves in a bug report: the event it ran at, and
 * where the element was (`from`) against where it was sent (`to`), in whole
 * seconds. Nothing is logged when the first check finds it already there.
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
