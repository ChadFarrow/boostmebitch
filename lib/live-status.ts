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
 * An eligible episode whose guid is ABSENT from the response is marked
 * `'ended'`: the broadcast finished and the publisher dropped the item, so its
 * badge should go (LiveBadge renders null for 'ended'). Callers must only pass
 * items from a response they know succeeded — see the `ok` flag on
 * /api/live-status. Merging an errored or unreachable-feed response would end
 * a broadcast that is still running.
 *
 * A `startTime` the feed has stopped publishing is preserved rather than
 * erased; losing it would silently drop the "started …" line in the UI.
 *
 * Returns the SAME array reference when nothing changed, so the caller can skip
 * setState and the re-render with it.
 */
export function applyLiveStatuses(
  episodes: Episode[],
  items: LiveStatusItem[],
): Episode[] {
  const byGuid = new Map(items.map((i) => [i.guid, i]));
  let changed = false;
  const next = episodes.map((e) => {
    if (!e.liveStatus) return e;
    const hit = e.guid ? byGuid.get(e.guid) : undefined;
    if (hit) {
      const startTime = hit.startTime ?? e.liveStartTime;
      if (e.liveStatus === hit.status && e.liveStartTime === startTime) return e;
      changed = true;
      return { ...e, liveStatus: hit.status, liveStartTime: startTime };
    }
    if (e.liveStatus === 'ended') return e;
    changed = true;
    return { ...e, liveStatus: 'ended' as const };
  });
  return changed ? next : episodes;
}
