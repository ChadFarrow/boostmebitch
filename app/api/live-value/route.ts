import { NextResponse } from 'next/server';
import { getPodcast, getLiveItemsFromRssDetailed, resolveLiveSplit, LIVE_XML_MAX_AGE_MS } from '@/lib/pi';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';


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
    const { ok, items } = await getLiveItemsFromRssDetailed(podcast.url, feedId, podcast.podcastGuid, {
      maxAgeMs: LIVE_XML_MAX_AGE_MS,
    });
    // A feed we could not READ is not a feed without the item. Answering it
    // with `liveStatus: 'ended'` (as this route did until 2026-11-26) counted
    // toward `endedVerdict`, so two polls during a host's outage, a timeout or
    // a 5xx ended the broadcast for the streaming engine mid-show and settled
    // it early. A 503 lands in the watcher's `catch`, which keeps paying the
    // last known target and gives up only after MAX_FAILURES — the branch
    // built for "we lost the feed". No-store: the next poll must ask again.
    if (!ok) {
      return NextResponse.json(
        { error: 'the feed could not be read' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const item = items.find((e) => e.guid === guid);
    // The live item disappearing from a feed we DID read (broadcast ended, feed
    // rewritten) is not an error — it means there is nothing to redirect to any
    // more.
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
