import { NextResponse } from 'next/server';
import { getEpisodeByGuid } from '@/lib/pi';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';

// Resolve a single episode from its Podcasting 2.0 guids — the feed/show guid
// (podcast:guid) plus the item guid (podcast:item:guid). Used by the "+ queue"
// button on Nostr note cards, which only has these guids off the note's NIP-73
// `i` tags and needs a full, playable Episode to enqueue.
export async function GET(req: Request) {
  const limited = rateLimit(req, 'episode', 60);
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const feedGuid = searchParams.get('feedGuid')?.trim();
  const itemGuid = searchParams.get('itemGuid')?.trim();
  if (!feedGuid || !itemGuid) {
    return NextResponse.json({ error: 'missing feedGuid or itemGuid' }, { status: 400 });
  }
  if (feedGuid.length > 120 || itemGuid.length > 512) {
    return NextResponse.json({ error: 'invalid guid' }, { status: 400 });
  }
  return withErrorHandling(async () => {
    const episode = await getEpisodeByGuid(feedGuid, itemGuid);
    if (!episode) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(
      { episode },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    );
  }, 'episode lookup failed');
}
