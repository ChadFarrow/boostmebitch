import { NextResponse } from 'next/server';
import { getPodcast, getLiveItemsFromRss, resolveLiveSplit } from '@/lib/pi';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';

// How stale the feed XML may be when answering. A live music show turns over
// every few minutes, so the shared 60 s RSS window is too coarse — but this
// override applies to THIS call only (see fetchFeedXml), so the normal feed
// path keeps its cheaper cache.
const LIVE_XML_MAX_AGE_MS = 10_000;

/**
 * What is a live item playing right now?
 *
 * GET /api/live-value?feedId=<n>&guid=<liveItemGuid>
 *   → { split: ValueTimeSplit | null, signal: 'remote-item'|'value-time-split'|'value'|'none' }
 *
 * `signal: 'none'` is a normal answer, not an error: most live items publish
 * no now-playing pointer at all, and the caller keeps paying the show's own
 * value block. See resolveLiveSplit for the precedence rules.
 */
export async function GET(req: Request) {
  // Polled while a live show plays (see lib/v4v/live-value.ts), so this runs
  // hotter than /api/value-splits' 30.
  const limited = rateLimit(req, 'live-value', 60);
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const feedId = Number(searchParams.get('feedId'));
  const guid = searchParams.get('guid');
  if (!Number.isInteger(feedId) || feedId <= 0) {
    return NextResponse.json({ error: 'missing or invalid feedId' }, { status: 400 });
  }
  if (!guid || guid.length > 2048) {
    return NextResponse.json({ error: 'missing or invalid guid' }, { status: 400 });
  }
  return withErrorHandling(async () => {
    const podcast = await getPodcast(feedId);
    if (!podcast?.url) return NextResponse.json({ error: 'feed not found' }, { status: 404 });
    const items = await getLiveItemsFromRss(podcast.url, feedId, podcast.podcastGuid, {
      maxAgeMs: LIVE_XML_MAX_AGE_MS,
    });
    const item = items.find((e) => e.guid === guid);
    // The live item disappearing (broadcast ended, feed rewritten) is not an
    // error — it means there is nothing to redirect to any more.
    if (!item) {
      return NextResponse.json({ split: null, signal: 'none', value: null, liveStatus: 'ended' });
    }
    const result = await resolveLiveSplit(item);
    return NextResponse.json({
      ...result,
      // The live item's OWN value block, echoed so the client can tell a feed
      // that rewrites it per track from one that simply has a block and never
      // touches it. That distinction can only be made across polls, so it
      // can't be made here.
      value: item.value ?? null,
      liveStatus: item.liveStatus ?? null,
    }, {
      // Short, but non-zero: a page with several listeners on the same show
      // shouldn't multiply into one PI + one RSS fetch each per poll.
      headers: { 'Cache-Control': 'public, max-age=10, s-maxage=10' },
    });
  }, 'live-value fetch failed');
}
