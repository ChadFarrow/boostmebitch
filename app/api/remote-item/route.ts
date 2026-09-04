import { NextResponse } from 'next/server';
import { resolveRemoteItemParent } from '@/lib/pi';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';

/**
 * Can this remote item's parent feed be resolved?
 *
 * GET /api/remote-item?feedGuid=<uuid>&itemGuid=<guid>
 *   → { parentFeedGuid?: string | null, feedTitle?: string, artist?: string }
 *
 * The three states of `parentFeedGuid` are the load-bearing part — see
 * `ValueTimeSplit.parentFeedGuid`. An ABSENT key is the `undefined` state
 * ("nothing learned, the wire guid stands"), which is also what a PI miss
 * answers, so a caller must not read absence as a refusal. `feedTitle` and
 * `artist` are labels beside it, and each is absent whenever its lookup missed.
 *
 * `<LivePlayedTracks>`' log is the caller, on both live signals rather than
 * only the socket one: an RSS split arrives with its verdict already settled by
 * `resolveOneSplit` inside /api/live-value, but with no artist either way,
 * because Podcast Index carries `author` on the feed record and not on the
 * episode. See `resolveRemoteItemParent` for why no value block comes back.
 */
export async function GET(req: Request) {
  // One call per distinct block a live show puts on air — a few per hour per
  // listener — but a long DJ set on a shared IP adds up, so this sits with
  // /api/live-value's allowance rather than the by-guid hydration burst.
  const limited = rateLimit(req, 'remote-item', 60);
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const feedGuid = searchParams.get('feedGuid')?.trim();
  const itemGuid = searchParams.get('itemGuid')?.trim();
  if (!feedGuid || !itemGuid) {
    return NextResponse.json({ error: 'missing feedGuid or itemGuid' }, { status: 400 });
  }
  // Same caps as /api/episode-by-guid: feed guids are UUIDs, item guids are any
  // globally-unique string and real feeds use permalink URLs.
  if (feedGuid.length > 120) return NextResponse.json({ error: 'invalid feedGuid' }, { status: 400 });
  if (itemGuid.length > 2048) return NextResponse.json({ error: 'invalid itemGuid' }, { status: 400 });
  return withErrorHandling(async () => {
    const parent = await resolveRemoteItemParent(feedGuid, itemGuid);
    return NextResponse.json(
      parent,
      // A publisher chain does not change between broadcasts, so this is the
      // one part of a live show worth caching for longer than a poll.
      { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400' } },
    );
  }, 'remote item lookup failed');
}
