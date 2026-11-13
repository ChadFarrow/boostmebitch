// The favorites shuffle's loader (docs/ui.md, "The favorites shuffle").
//
// TWO HALVES, AND THE SPLIT IS THE DESIGN. `readShuffleTracks` is synchronous:
// it reads only what the episode cache already holds, so the press can set
// `current` before it returns — iOS ties `play()` to the gesture, and an
// `await` over real I/O loses it. `loadPendingShuffleTracks` fetches the rest
// AFTER the first track is playing, through the batch door only.
//
// NEVER ONE GET PER TRACK. `resolveEpisodeByGuid` falls back to a GET per item,
// and after a failed batch (the route allows 30 requests a minute per IP, and
// `warmEpisodeCache` stops at the first failed chunk) that is one request per
// favorite — 232 on the reference library. A miss after the warm is a skipped
// track, counted and said, never a second fan-out.

import type { FavoriteEpisode, QueueItem } from './types';
import { cachedEpisodeByGuid, warmEpisodeCache } from './podcast-meta';
import { shuffleTrackFor } from './util';

export interface ShuffleRead {
  /** Playable now, from the cache. */
  tracks: QueueItem[];
  /** Not cached yet: ask the batch door. */
  pending: FavoriteEpisode[];
  /** Cannot play: no feed guid, Podcast Index had none, or no enclosure. */
  skipped: number;
}

/** What the cache can play right now, with no request. */
export function readShuffleTracks(rows: readonly FavoriteEpisode[]): ShuffleRead {
  const tracks: QueueItem[] = [];
  const pending: FavoriteEpisode[] = [];
  let skipped = 0;
  for (const fav of rows) {
    // An entry with no parent ref cannot be looked up on any device.
    if (!fav.feedGuid || !fav.itemGuid) { skipped += 1; continue; }
    const episode = cachedEpisodeByGuid(fav.feedGuid, fav.itemGuid);
    if (episode === undefined) { pending.push(fav); continue; }
    const track = episode ? shuffleTrackFor(fav, episode) : null;
    if (track) tracks.push(track);
    else skipped += 1;
  }
  return { tracks, pending, skipped };
}

/** The misses, through `warmEpisodeCache` and then the cache alone. Never rejects. */
export async function loadPendingShuffleTracks(
  pending: readonly FavoriteEpisode[],
): Promise<{ tracks: QueueItem[]; skipped: number }> {
  if (!pending.length) return { tracks: [], skipped: 0 };
  try {
    await warmEpisodeCache(pending.map((f) => ({ feedGuid: f.feedGuid!, itemGuid: f.itemGuid })));
  } catch {
    // An accelerator that failed. What it did not fill is counted below.
  }
  const tracks: QueueItem[] = [];
  let skipped = 0;
  for (const fav of pending) {
    const episode = cachedEpisodeByGuid(fav.feedGuid!, fav.itemGuid);
    const track = episode ? shuffleTrackFor(fav, episode) : null;
    if (track) tracks.push(track);
    else skipped += 1;
  }
  return { tracks, skipped };
}
