import { NextResponse } from 'next/server';
import { getItemPaymentFromRss, getPodcast, getPodcastByGuid } from '@/lib/pi';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';

// Who one item pays, read from its parent feed when somebody plays it or presses
// BOOST. Every row a route built without reading that feed reads as not read
// (`valueNotRead`, lib/util.ts): a playlist row, a stored copy, a favorite.
//
// Podcast Index is the DIRECTORY here, turning a guid or an id into a feed URL. It
// never supplies the payee. The route takes no URL, so a caller cannot aim
// `safeFetch` at anything Podcast Index does not list.
//
// A feed that did not answer is `{ read: false }`, and `no-store`, so the listener's
// next press reaches the host again.

const ITEM_VALUE_CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';

export async function GET(req: Request) {
  const limited = rateLimit(req, 'item-value', 120);
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const feedGuid = searchParams.get('feedGuid')?.trim();
  const feedIdParam = searchParams.get('feedId')?.trim();
  const itemGuid = searchParams.get('itemGuid')?.trim();
  const feedId = feedIdParam && /^[1-9][0-9]{0,15}$/.test(feedIdParam) ? Number(feedIdParam) : 0;
  if (!itemGuid || (!feedGuid && !feedId)) {
    return NextResponse.json({ error: 'missing itemGuid, or feedGuid / feedId' }, { status: 400 });
  }
  if (feedGuid && feedGuid.length > 120) return NextResponse.json({ error: 'invalid feedGuid' }, { status: 400 });
  if (itemGuid.length > 2048) return NextResponse.json({ error: 'invalid itemGuid' }, { status: 400 });
  return withErrorHandling(async () => {
    const podcast = feedGuid ? await getPodcastByGuid(feedGuid) : await getPodcast(feedId);
    if (!podcast?.url) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const payment = await getItemPaymentFromRss(podcast.url, itemGuid);
    return NextResponse.json(payment, {
      headers: { 'Cache-Control': payment.read ? ITEM_VALUE_CACHE : 'no-store' },
    });
  }, 'item value lookup failed');
}
