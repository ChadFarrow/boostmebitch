import { NextResponse } from 'next/server';
import { getPodcast, getLiveItemsFromRssDetailed } from '@/lib/pi';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import type { LiveStatusItem } from '@/lib/live-status';

// How stale the feed XML may be when answering. Mirrors /api/live-value: the
// override applies to THIS call only (see fetchFeedXml), so /api/feed keeps its
// cheaper shared 60 s window.
const LIVE_XML_MAX_AGE_MS = 10_000;

/**
 * What is the status of this feed's live items right now?
 *
 * GET /api/live-status?id=<feedId>
 *   → { ok: true, items: [{ guid, status, startTime }] }
 *
 * Polled by the show page while a live item is on screen, so it answers one
 * question and does no split resolution. RSS only, no PI /episodes/live call:
 * PI lags the transition badly — observed 2026-08-07 with a feed publishing
 * status="live" while PI returned zero live items for it — so the extra 1000-
 * record fetch per poll would buy nothing.
 */
export async function GET(req: Request) {
  // Polled, so the same budget /api/live-value gets rather than the default 30.
  const limited = rateLimit(req, 'live-status', 60);
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const id = Number(searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'missing or invalid id' }, { status: 400 });
  }
  return withErrorHandling(async () => {
    const podcast = await getPodcast(id);
    if (!podcast?.url) return NextResponse.json({ error: 'feed not found' }, { status: 404 });
    const { ok, items } = await getLiveItemsFromRssDetailed(
      podcast.url,
      id,
      podcast.podcastGuid,
      { maxAgeMs: LIVE_XML_MAX_AGE_MS },
    );
    // An unreadable feed is NOT an empty one. Answering 200 with [] here tells
    // the client every live item ended, which would strip a LIVE badge in the
    // middle of a broadcast.
    if (!ok) return NextResponse.json({ error: 'feed unreachable' }, { status: 503 });
    return NextResponse.json(
      {
        ok: true,
        // Matching is by guid, so an item without one is unusable to the client.
        // The type predicate narrows Episode['liveStatus'] ('pending' | 'live' |
        // 'ended' | undefined) down to LiveStatusItem['status'] ('pending' |
        // 'live') — today that narrowing is a no-op because parseRssLiveItems
        // can only ever emit the narrow pair, but the compiler now enforces
        // that fact instead of it being an unchecked assumption; the mapped
        // array's LiveStatusItem[] annotation makes the whole thing a
        // compile-time contract with lib/live-status.ts (isomorphic and
        // type-only, so importing its type here costs nothing at runtime).
        items: items
          .filter(
            (e): e is typeof e & { guid: string; liveStatus: 'pending' | 'live' } =>
              !!e.guid && (e.liveStatus === 'pending' || e.liveStatus === 'live'),
          )
          .map((e): LiveStatusItem => ({
            guid: e.guid,
            status: e.liveStatus,
            startTime: e.liveStartTime,
          })),
      },
      { headers: { 'Cache-Control': 'public, max-age=10, s-maxage=10' } },
    );
  }, 'live-status fetch failed');
}
