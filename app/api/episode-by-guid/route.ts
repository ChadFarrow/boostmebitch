import { NextResponse } from 'next/server';
import { getEpisodeByGuid } from '@/lib/pi';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';

/**
 * Resolve a NIP-73 `podcast:item:guid:` favorite back into an Episode.
 *
 * BOTH guids are required — PI's /episodes/byguid wants `podcastguid` to
 * disambiguate, and an item guid alone is not a reliable lookup key. That's
 * why the shared favorites list carries the parent feed alongside every item
 * (see docs/pc20-favorites.md).
 */
export async function GET(req: Request) {
  // Same allowance as /api/by-guid: favorites hydration fans out across a
  // whole list on a fresh device.
  const limited = rateLimit(req, 'episode-by-guid', 300);
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const feedGuid = searchParams.get('feedGuid')?.trim();
  const itemGuid = searchParams.get('itemGuid')?.trim();
  if (!feedGuid || !itemGuid) {
    return NextResponse.json({ error: 'missing feedGuid or itemGuid' }, { status: 400 });
  }
  // Feed guids are UUIDs; item guids are any globally-unique string per the
  // spec, and real feeds use permalink URLs, so give that one URL-ish slack.
  if (feedGuid.length > 120) return NextResponse.json({ error: 'invalid feedGuid' }, { status: 400 });
  if (itemGuid.length > 2048) return NextResponse.json({ error: 'invalid itemGuid' }, { status: 400 });
  return withErrorHandling(async () => {
    const episode = await getEpisodeByGuid(feedGuid, itemGuid);
    // 404, never 500 — a 5xx trips the client-side breaker and disables ALL
    // metadata resolution for the rest of the tab.
    if (!episode) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(
      { episode },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    );
  }, 'lookup failed');
}
