import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { getPublisherAlbumUrls } from '@/lib/musicl-resolver';
import { getPodcastByFeedUrl } from '@/lib/pi';

// Publisher feeds are effectively static — new albums appear rarely — and this
// is by far the most expensive route here (one RSS fetch plus a PI call per
// album). It was the only 200 in app/api without a cache header.
const PUBLISHER_CACHE = { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' };

// Hard ceiling on the PI fan-out. The album list comes from a third-party
// publisher feed, so its length is attacker-chosen: without a cap, one cheap
// request became N parallel Podcast Index calls, and at the 30/min rate limit
// that is a request-amplification lever pointed at our PI quota. Real publisher
// feeds list a handful of albums; 100 is far above any observed one.
const MAX_PUBLISHER_ALBUMS = 100;

export async function GET(req: Request) {
  const limited = rateLimit(req, 'publisher', 30);
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const feedUrl = searchParams.get('feedUrl')?.trim();
  if (!feedUrl) return NextResponse.json({ feeds: [] });
  if (feedUrl.length > 2048) return NextResponse.json({ error: 'invalid feedUrl' }, { status: 400 });
  return withErrorHandling(async () => {
    const albumUrls = (await getPublisherAlbumUrls(feedUrl)).slice(0, MAX_PUBLISHER_ALBUMS);
    if (!albumUrls.length) return NextResponse.json({ feeds: [] }, { headers: PUBLISHER_CACHE });

    // Probe-first-then-batch, the repo's convention for PI fan-outs: resolve one
    // before firing the rest so a degraded PI costs a single call instead of N.
    // Deliberately NOT caught — getPodcastByFeedUrl already swallows PI's 400/404
    // "feed not found" into null, so a throw here means PI itself is down, and
    // the resulting 5xx is what trips the client-side breaker in lib/podcast-meta.
    const probe = await getPodcastByFeedUrl(albumUrls[0]);
    const rest = await Promise.all(
      albumUrls.slice(1).map((url) => getPodcastByFeedUrl(url).catch(() => null)),
    );
    const feeds = [probe, ...rest].filter((f): f is NonNullable<typeof f> => f !== null);
    return NextResponse.json({ feeds }, { headers: PUBLISHER_CACHE });
  }, 'publisher resolution failed');
}
