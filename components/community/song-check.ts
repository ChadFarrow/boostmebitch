'use client';

// Can a song play? One copy for the two places that ask: the Add songs sheet
// (before a song goes in) and the maker's EDIT view (which songs already in a
// playlist died since). Browser-only: it asks our own routes.

import { useApp } from '@/lib/store';
import { isHlsUrl } from '@/lib/util';
import { closedService } from '@/lib/moved-feeds';
import type { Episode } from '@/lib/types';

/** What the caller already knows about a song, so nothing is asked twice. */
export type SongKnown = {
  enclosureUrl?: string;
  image?: string;
  feedUrl?: string;
  /** Podcast Index answered "not found" for it (`/api/playlist`'s `unresolved: 'not-found'`). */
  notFound?: boolean;
};

/**
 * Can this song play? Asked when + ADD is pressed, before the song goes in
 * (Chad, 2026-11-15: "if it's not findable, don't let them add it"), and by the
 * EDIT view for every song already in the playlist, so one that died since is
 * marked ("make it obvious which ones are dead").
 *
 * 1. A file, cover or feed on a host that CLOSED (`lib/moved-feeds.ts`): Podcast
 *    Index still lists those as healthy, and every RSS Blue file answers 410.
 * 2. No known file: ask `/api/episode-by-guid`. A 404 is "Podcast Index does not
 *    have it"; any other failure is "could not ask", which lets the song in —
 *    the server checks again at PUBLISH (`verifySongs`).
 * 3. The file itself, through `/api/audio-probe`: 404 or 410 is gone, the same
 *    narrow set the player uses. A 403, a 5xx or a timeout is a host's bad
 *    minute, not a deletion, so it lets the song in.
 * Returns the reason to show, or null when the song may go in.
 */
export async function whyNotPlayable(
  feedGuid: string,
  itemGuid: string,
  known: SongKnown,
): Promise<string | null> {
  if (known.notFound) return 'Podcast Index does not have this song.';
  const closed = (u?: string) => closedService(u);
  const host = closed(known.enclosureUrl) ?? closed(known.feedUrl) ?? closed(known.image);
  if (host) return `Its host (${host}) closed.`;
  let file = known.enclosureUrl;
  if (!file) {
    try {
      const r = await fetch(`/api/episode-by-guid?feedGuid=${encodeURIComponent(feedGuid)}&itemGuid=${encodeURIComponent(itemGuid)}`);
      if (r.status === 404) return 'Podcast Index does not have this song.';
      if (r.ok) {
        const ep = ((await r.json()) as { episode?: Episode }).episode;
        const h = closed(ep?.enclosureUrl) ?? closed(ep?.image) ?? closed(ep?.feedImage);
        if (h) return `Its host (${h}) closed.`;
        file = ep?.enclosureUrl;
      }
    } catch { /* could not ask: let it in, PUBLISH checks again */ }
  }
  if (!file || isHlsUrl(file)) return null;
  try {
    const r = await fetch(`/api/audio-probe?url=${encodeURIComponent(file)}`, { signal: AbortSignal.timeout(10_000) });
    const status = r.ok ? ((await r.json()) as { status?: number }).status : undefined;
    if (status === 404 || status === 410) {
      useApp.getState().markFileGone(file);
      return `Its audio file is gone (${status}).`;
    }
  } catch { /* could not ask: let it in */ }
  return null;
}

