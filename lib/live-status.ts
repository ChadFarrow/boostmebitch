import type { Episode } from './types';

/**
 * One live item as `/api/live-status` reports it. `status`/`startTime` are the
 * wire names for `Episode.liveStatus` / `Episode.liveStartTime`.
 */
export interface LiveStatusItem {
  guid: string;
  status: 'pending' | 'live';
  startTime?: number;
}

/**
 * Merge a successful `/api/live-status` response into the loaded episode list.
 *
 * Only episodes that already carry a `liveStatus` are eligible — a regular
 * episode is never touched, whatever the response says.
 *
 * An episode with NO guid can never be matched against a response (matching
 * is by guid — see the route). That is evidence the item is unmatchable, not
 * evidence the broadcast ended, so it is left exactly as loaded; only a fresh
 * `/api/feed` load can move it. Don't fold this into the "absent from the
 * response" branch below — they are different facts.
 *
 * An eligible, guid-bearing episode absent from the response is NOT ended on
 * the first miss. Our poll is RSS-only while `/api/feed` merges PI (which can
 * see a `pending → live` transition our RSS-only poll hasn't caught up to
 * yet) — see the CLAUDE.md note on this file for why that merge stays
 * RSS-only on the poll side. So one miss just increments that guid's counter
 * in the returned `misses` map; only the SECOND CONSECUTIVE miss (an entry
 * already at 1 in `prevMisses`) marks it `'ended'`. A guid present in ANY
 * later successful response resets its counter to 0 and adopts that
 * response's status unconditionally — including reviving an episode already
 * marked `'ended'`, which is what a rebroadcast reappearing should do.
 *
 * A `startTime` the feed has stopped publishing is preserved rather than
 * erased; losing it would silently drop the "started …" line in the UI.
 *
 * Callers must only pass items from a response they know succeeded — see the
 * `ok` flag on /api/live-status. Merging an errored or unreachable-feed
 * response would count misses (or worse, end broadcasts) that are still
 * running.
 *
 * Returns the SAME `episodes` array reference when nothing changed, so the
 * caller can skip setState and the re-render with it. `misses` is always a
 * fresh object — `prevMisses` is read, never mutated — and only carries
 * entries for episodes still eligible (has a guid, has a `liveStatus`, not
 * already `'ended'`), so it can't grow unboundedly.
 */
export function applyLiveStatuses(
  episodes: Episode[],
  items: LiveStatusItem[],
  prevMisses: Readonly<Record<string, number>>,
): { episodes: Episode[]; misses: Record<string, number> } {
  const byGuid = new Map(items.map((i) => [i.guid, i]));
  const misses: Record<string, number> = {};
  let changed = false;
  const next = episodes.map((e) => {
    if (!e.liveStatus) return e;
    // Unmatchable, not unbroadcast — see the doc comment above.
    if (!e.guid) return e;
    const hit = byGuid.get(e.guid);
    if (hit) {
      // Present in this successful response: reset the miss counter (an
      // explicit 0, not an absent entry) and adopt the reported status
      // unconditionally, even if this episode was already 'ended' — a
      // reappearing guid is a rebroadcast.
      misses[e.guid] = 0;
      const startTime = hit.startTime ?? e.liveStartTime;
      if (e.liveStatus === hit.status && e.liveStartTime === startTime) return e;
      changed = true;
      return { ...e, liveStatus: hit.status, liveStartTime: startTime };
    }
    if (e.liveStatus === 'ended') return e; // already ended, nothing left to track
    const missCount = (prevMisses[e.guid] ?? 0) + 1;
    if (missCount >= 2) {
      changed = true;
      return { ...e, liveStatus: 'ended' as const };
    }
    misses[e.guid] = missCount;
    return e;
  });
  return { episodes: changed ? next : episodes, misses };
}
