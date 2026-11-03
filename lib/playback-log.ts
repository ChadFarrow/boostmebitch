'use client';
import { storage } from './storage';
import { formatPlaybackLogLine, PLAYBACK_LOG_CAP, type PlaybackLogFields } from './playback-log-line';
import { epKey, fnvHash } from './util';
import type { Episode } from './types';

// The playback diagnostic log: the last PLAYBACK_LOG_CAP things the player and
// the page did, kept on the device, and attached to "Report a bug" under the
// same "Include app info" consent as the snapshot.
//
// WHY IT EXISTS. "The next item in the queue doesn't play with the screen
// locked" was reported from the Android app (2026-10-30) and did not
// reproduce in nine emulator runs: Chrome and Brave, TWA and tab, streamed and
// downloaded, locked for 12 s and for 7 minutes, under forced deep Doze. Every
// run advanced. A fault that only the listener's own phone produces leaves no
// evidence anywhere — the console is gone by the time anybody looks, and the
// listener cannot say whether the episode ended or stopped, or what the screen
// showed. This is that evidence, written where it happens.
//
// WHAT IT HOLDS: event codes, readyState, whole seconds of currentTime, paused,
// visibility, play() outcomes and their DOMException names, the KIND of
// source (stream / local / hls), and `item`, a hash of the episode key that
// tells one item from the next without naming it. WHAT IT NEVER HOLDS: a URL,
// a title, a guid, an npub, an amount — the line format refuses the
// characters most of them need (`lib/playback-log-line.ts`), and the route
// re-checks every line.
//
// Browser-only. Every write goes to disk at once, because the case this is for
// is a page the OS froze or discarded with the screen off, and the lines
// before that are the point.
//
// **Read, append, write — no copy in memory.** A module-level copy outlives
// the disk it was read from: a second tab appends to its own stale copy and
// writes it back over the first tab's lines. One parse of a few kilobytes per
// line is nothing next to that, and the events logged here are sparse.

export function logPlayback(code: string, fields?: PlaybackLogFields): void {
  if (typeof window === 'undefined') return;
  const line = formatPlaybackLogLine(new Date(), code, fields);
  if (!line) return;
  const l = storage.playbackLog.get();
  l.push(line);
  storage.playbackLog.set(l.slice(-PLAYBACK_LOG_CAP));
}

/** Oldest first — what the bug report shows and sends. */
export function playbackLogLines(): string[] {
  return storage.playbackLog.get();
}

/** Tells one item from the next without naming it. */
export function playbackItemId(episode: Pick<Episode, 'guid' | 'feedId' | 'id'>): string {
  return fnvHash(epKey(episode)).toString(36);
}

// Not `timeupdate`, `progress` or `suspend`: they fire several times a second
// and would push the transition this exists for out of the ring in a minute.
const MEDIA_EVENTS = [
  'loadstart', 'loadedmetadata', 'canplay', 'play', 'playing', 'pause', 'ended',
  'waiting', 'stalled', 'seeked', 'emptied', 'abort', 'error',
] as const;

/**
 * Logs one media element's events and EVERY `play()` called on it.
 *
 * **The events are heard in the CAPTURE phase**, and that is the whole
 * difference between a true line and a false one. React listens on the media
 * element itself, in the bubble phase, and was there first; its `onEnded`
 * schedules a sync re-render whose effect re-sources the element in the
 * microtask checkpoint after its listener returns. A bubble listener added
 * after it therefore ran on the NEXT source and wrote `m.ended rs=0 ct=0`,
 * after the advance it caused. At the target, capture listeners run before
 * bubble ones (DOM spec; Chromium 89+), so this one reads the element as it
 * ended. Not a capture listener on `document`: the <video> lives in a reverse
 * portal node that is detached whenever it is not shown, and a detached
 * element's events never reach the document.
 *
 * `play()` is wrapped on the INSTANCE rather than at each call site: the
 * player calls it from three (the audio source effect's `attach`, the
 * play/pause effect, and `playOrPark`, which several paths share), and a
 * refusal is a promise, not an event, so the media events alone cannot show
 * it. The wrapper returns the
 * same promise, so the caller's own `.catch` still runs; the cleanup removes
 * the own property, which puts the prototype's back.
 */
export function watchMediaElement(el: HTMLMediaElement, tag: 'a' | 'v'): () => void {
  const onEvent = (e: Event) => {
    logPlayback(`m.${e.type}`, {
      el: tag,
      rs: el.readyState,
      ct: Math.floor(el.currentTime || 0),
      paused: el.paused,
      err: e.type === 'error' ? el.error?.code : undefined,
    });
  };
  for (const ev of MEDIA_EVENTS) el.addEventListener(ev, onEvent, { capture: true });

  const play = HTMLMediaElement.prototype.play;
  el.play = function loggedPlay(this: HTMLMediaElement) {
    logPlayback('play.call', { el: tag, rs: this.readyState, vis: document.visibilityState });
    const p = play.call(this);
    p.then(
      () => logPlayback('play.ok', { el: tag }),
      (e: unknown) => logPlayback('play.err', { el: tag, name: e instanceof DOMException ? e.name : 'error' }),
    );
    return p;
  };

  return () => {
    for (const ev of MEDIA_EVENTS) el.removeEventListener(ev, onEvent, { capture: true });
    delete (el as { play?: unknown }).play;
  };
}

let loadLogged = false;

/**
 * Logs the page's own lifecycle: the load (and whether the browser DISCARDED
 * the page before it — Chromium's `document.wasDiscarded`), visibility,
 * `pagehide`, `freeze`/`resume`, and the network. Returns the cleanup.
 *
 * The `load` line is written once per document, so a Fast Refresh re-running
 * the effect does not record a load that never happened.
 */
export function startPlaybackLog(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (!loadLogged) {
    loadLogged = true;
    const nav = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
    logPlayback('load', {
      date: new Date().toISOString().slice(0, 10),
      nav: nav?.type,
      discarded: (document as Document & { wasDiscarded?: boolean }).wasDiscarded,
      vis: document.visibilityState,
    });
  }
  const onVis = () => logPlayback('vis', { state: document.visibilityState });
  const onHide = (e: PageTransitionEvent) => logPlayback('pagehide', { persisted: e.persisted });
  const onFreeze = () => logPlayback('freeze');
  const onResume = () => logPlayback('resume');
  const onOnline = () => logPlayback('net', { online: true });
  const onOffline = () => logPlayback('net', { online: false });
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', onHide);
  document.addEventListener('freeze', onFreeze);
  document.addEventListener('resume', onResume);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  return () => {
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('pagehide', onHide);
    document.removeEventListener('freeze', onFreeze);
    document.removeEventListener('resume', onResume);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
}
