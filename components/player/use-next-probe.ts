'use client';

import { useEffect, useRef } from 'react';
import { useApp } from '@/lib/store';
import { epKey, isHlsUrl } from '@/lib/util';
import { logPlayback, playbackItemId } from '@/lib/playback-log';

/** How long before the end of a track the next one's file is checked. */
const PROBE_LEAD_SEC = 30;

/**
 * The upstream answers that mean the file is GONE. Deliberately narrow: a 403
 * may be hotlink protection the browser itself would pass, and a 5xx or a
 * timeout is the host's bad minute, not a deletion — those still go to the
 * element, and the error path (`skipDeadTrack`) is the fallback.
 */
const GONE = new Set([404, 410]);

/** Enclosure URLs found gone in this tab. Memory only: a deleted file stays
 *  deleted for a session, and a reload asks again. */
const goneUrls = new Set<string>();

/** Did the early check find this file gone? */
export function isKnownGoneFile(url: string | undefined): boolean {
  return !!url && goneUrls.has(url);
}

/**
 * Checks the file a track ENDING would move to, ~30 s before the end, so a
 * dead one is passed over BEFORE the audio element loads it (`<Player>`'s
 * `advanceOnItsOwn`).
 *
 * WHY THE ERROR PATH WAS NOT ENOUGH: on an iPhone in the background a dead
 * file's load error ENDS the page's audio. WebKit makes an element's media
 * session inactive on a fatal load error, and a hidden page cannot start
 * audio again. `skipDeadTrack` moved on and the next track reported `playing`,
 * but it sat at 0:00 (Chad, 2026-11-13, #555 — three ordinary track changes in
 * the background had worked just before it). The page cannot ask the host
 * itself — most enclosure hosts send no CORS headers, and an opaque 410 looks
 * like a 200 — so it asks `/api/audio-probe`.
 *
 * `peekNextOnEnd` answers for the listen queue, the shuffle and an album, and
 * null for anything that stops when it ends. Once per item; never for a live
 * item, an HLS stream, a downloaded (`blob:`) file, or offline. Each answer
 * writes `probe item=… status=…` to the playback log.
 */
export function useNextProbe(duration: number, live: boolean): void {
  const current = useApp((s) => s.current);
  const isPlaying = useApp((s) => s.isPlaying);
  const positionSec = useApp((s) => s.positionSec);
  const doneFor = useRef<string | null>(null);

  const key = current ? epKey(current.episode) : null;
  const left = Number.isFinite(duration) && duration > 0 ? duration - positionSec : Infinity;
  const due = !!key && isPlaying && !live && left > 0 && left <= PROBE_LEAD_SEC;

  useEffect(() => {
    if (!due || !key || doneFor.current === key) return;
    doneFor.current = key;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const next = useApp.getState().peekNextOnEnd();
    const url = next?.episode.enclosureUrl;
    if (!next || !url || !/^https?:\/\//i.test(url) || isHlsUrl(url) || next.episode.liveStatus) return;
    if (goneUrls.has(url)) return;
    const item = playbackItemId(next.episode);
    fetch(`/api/audio-probe?url=${encodeURIComponent(url)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { status?: unknown } | null) => {
        const status = typeof j?.status === 'number' ? j.status : null;
        if (status !== null && GONE.has(status)) goneUrls.add(url);
        logPlayback('probe', { item, status: status ?? 'none' });
      })
      .catch(() => logPlayback('probe', { item, status: 'err' }));
  }, [due, key]);
}
