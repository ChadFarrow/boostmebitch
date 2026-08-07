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
    //
    // It does NOT cover the caller's own state timing: EpisodeList only clears
    // `data` when feedId goes to null, so a same-tick switch from show A to
    // show B re-keys this effect to B (and, with the immediate poll below, can
    // resolve) while `data` still holds A's episodes — merging B's live items
    // onto A's list for a moment. Invisible (the component is rendering
    // "loading episodes…" at that point) and overwritten the instant B's own
    // /api/feed fetch lands.
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

    // Poll once on activation, not just on the next interval tick — /api/feed
    // can be up to ~5 min stale (its own s-maxage=300 plus the 60 s RSS cache),
    // so without this a freshly-loaded pending/stale badge (and the disabled
    // play button that comes with 'pending') would sit for up to another 45 s
    // for no reason. The POLL_MIN_MS floor already stops this from stacking
    // with a focus/visibilitychange landing moments later.
    maybePoll();
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
