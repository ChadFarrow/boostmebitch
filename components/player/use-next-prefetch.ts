'use client';

import { useEffect, useRef } from 'react';
import { useApp } from '@/lib/store';
import { IS_BETA } from '@/lib/beta';
import { epKey, isHlsUrl } from '@/lib/util';
import { logPlayback, playbackItemId } from '@/lib/playback-log';

/** How long before the end of a track the next one's file is fetched. */
const PREFETCH_LEAD_SEC = 30;

/**
 * BETA ONLY — an experiment for one iPhone bug, and it is gated so a merge
 * cannot ship it (`IS_BETA`, `NEXT_PUBLIC_BETA=1`). See docs/ui.md, "The next
 * file is fetched early on beta".
 *
 * Bug report #546 (the Home Screen app, a favorites shuffle, the app in the
 * background): a track ended, the shuffle set the next file and called
 * `play()`, its metadata arrived — and then no data until the app came back to
 * the foreground 13 s later, when it played at once. The likely cause is iOS
 * suspending a hidden web app in the silent gap between two tracks.
 *
 * So ~30 s before the end, the file that a track ENDING would move to
 * (`peekNextOnEnd` — the listen queue, the shuffle, or an album's next track)
 * is fetched while this one still plays, in the hope that iOS's media loader
 * finds it in the cache. That hope is unproven: Safari drops `Range` on a
 * cross-origin no-cors fetch, so this is the WHOLE file, and Playwright's
 * WebKit keeps no HTTP cache, so nothing here could show whether it is reused.
 * Each fetch writes `prefetch` / `prefetch.ok` / `prefetch.err` to the playback
 * log, so the next report from the phone says whether the stall still happens
 * after one. If it does not help, this file goes.
 *
 * Once per item; never for a live item, an HLS stream or a device asking to
 * save data. A next track that is DOWNLOADED is still fetched — its episode
 * carries the remote URL — which costs data on beta only, and is a known gap.
 */
export function useNextPrefetch(duration: number, live: boolean): void {
  const current = useApp((s) => s.current);
  const isPlaying = useApp((s) => s.isPlaying);
  const positionSec = useApp((s) => s.positionSec);
  const doneFor = useRef<string | null>(null);

  const key = current ? epKey(current.episode) : null;
  const left = Number.isFinite(duration) && duration > 0 ? duration - positionSec : Infinity;
  const due = IS_BETA && !!key && isPlaying && !live && left > 0 && left <= PREFETCH_LEAD_SEC;

  useEffect(() => {
    if (!due || !key || doneFor.current === key) return;
    doneFor.current = key;
    if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
    const s = useApp.getState();
    const next = s.peekNextOnEnd();
    const url = next?.episode.enclosureUrl;
    if (!next || !url || url.startsWith('blob:') || isHlsUrl(url) || next.episode.liveStatus) return;
    if (url === s.current?.episode.enclosureUrl) return;
    const item = playbackItemId(next.episode);
    const t0 = Date.now();
    logPlayback('prefetch', { item, left: Math.round(left) });
    // no-cors: most enclosure hosts send no CORS headers. The response is
    // opaque, which is fine — nothing reads it; the point is the cache.
    fetch(url, { mode: 'no-cors', credentials: 'omit', priority: 'low' } as RequestInit)
      .then((r) => r.blob())
      .then(() => logPlayback('prefetch.ok', { item, ms: Date.now() - t0 }))
      .catch((e: unknown) => logPlayback('prefetch.err', { item, name: e instanceof Error ? e.name : 'error' }));
  }, [due, key]); // eslint-disable-line react-hooks/exhaustive-deps
}
