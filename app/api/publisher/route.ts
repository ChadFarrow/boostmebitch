import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { getPublisherAlbumUrls } from '@/lib/musicl-resolver';
import { getFeedFromRss, getPodcastByFeedUrl } from '@/lib/pi';
import type { Podcast } from '@/lib/types';

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
    const fromPi = [probe, ...rest];

    // A child Podcast Index does not hold is read straight from its RSS.
    //
    // A publisher feed is a list of feed URLs, and nothing says its children
    // were ever submitted to PI — the ChadF musicL publisher's nine children are
    // playlist feeds served off raw.githubusercontent.com. Before this, a `null`
    // here simply dropped the child, so a publisher of unindexed feeds rendered
    // as an EMPTY collection with no error: the failure mode that reads as "this
    // publisher has nothing" rather than as "we could not look these up".
    //
    // PI still WINS wherever it answered — it carries a real feed id, richer
    // metadata and no outbound fetch. This only fills the holes, and it fills
    // them with the same `isPreview` shape `/api/search` already falls back to
    // for a pasted URL PI doesn't know. `null` from the fallback too is a
    // genuine drop: that URL is not a feed.
    //
    // The PI probe above stays UNCAUGHT, so "PI is down" is still a 5xx and
    // never a page of RSS-derived children pretending PI agreed.
    const missing = fromPi
      .map((f, i) => (f === null ? albumUrls[i] : null))
      .filter((u): u is string => u !== null);
    const rescued = new Map<string, Podcast>();
    if (missing.length) {
      const parsed = await Promise.all(
        missing.map((url) => getFeedFromRss(url).then((r) => r?.podcast ?? null).catch(() => null)),
      );
      parsed.forEach((p, i) => { if (p) rescued.set(missing[i], p); });
    }

    const feeds = fromPi
      .map((f, i) => f ?? rescued.get(albumUrls[i]) ?? null)
      .filter((f): f is Podcast => f !== null);
    return NextResponse.json({ feeds }, { headers: PUBLISHER_CACHE });
  }, 'publisher resolution failed');
}
