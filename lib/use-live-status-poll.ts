'use client';

import { useEffect, useRef } from 'react';
import type { LiveStatusItem } from './live-status';

const POLL_MS = 45_000;
/** Overlapping triggers (interval + focus + visibilitychange) debounce to this. */
const POLL_MIN_MS = 30_000;

/**
 * Poll `/api/live-status` while the show page has a live item on screen.
 *
 * The show page fetches /api/feed once per feedId mount and never asks again,
 * so a <podcast:liveItem> going pending → live was invisible to anyone already
 * looking at it — and a pending badge disables the play button, locking the
 * listener out at exactly the wrong moment.
 *
 * Same shape as components/nostr-live-streams.tsx: interval plus focus and
 * visibilitychange, gated on document.hidden with a floor so the overlapping
 * triggers don't stack.
 *
 * `onItems` is held in a ref, so callers may pass an inline arrow without
 * memoizing — the effect depends only on feedId and active. It fires ONLY for
 * a successful `ok: true` response; every failure path is silent and leaves the
 * caller's state alone, because a stale badge beats an ended broadcast.
 */
export function useLiveStatusPoll(
  feedId: number | null,
  active: boolean,
  onItems: (items: LiveStatusItem[]) => void,
): void {
  const cbRef = useRef(onItems);
  cbRef.current = onItems;

  useEffect(() => {
    if (!feedId || !active) return;
    // Doubles as the generation guard: switching shows tears this effect down,
    // so a poll still in flight for the previous feed can't paint onto the new
    // one. Same hazard <Podroll>'s genRef exists for.
    let cancelled = false;
    let lastPollMs = 0;

    const maybePoll = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const now = Date.now();
      if (now - lastPollMs < POLL_MIN_MS) return;
      lastPollMs = now;
      fetch(`/api/live-status?id=${feedId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled || !d?.ok || !Array.isArray(d.items)) return;
          cbRef.current(d.items as LiveStatusItem[]);
        })
        .catch(() => {});
    };

    const timer = setInterval(maybePoll, POLL_MS);
    document.addEventListener('visibilitychange', maybePoll);
    window.addEventListener('focus', maybePoll);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', maybePoll);
      window.removeEventListener('focus', maybePoll);
    };
  }, [feedId, active]);
}
