import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { getPublisherAlbumUrls } from '@/lib/musicl-resolver';
import { getFeedFromRss, getPodcastByFeedUrl } from '@/lib/pi';
import { mergeRssOverPi, piRecordIsBlank } from '@/lib/util';
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

    // A child Podcast Index does not hold — OR holds BLANK — is read from RSS.
    //
    // Two distinct faults, one repair. Nothing says a publisher's children were
    // ever submitted to PI (these are served off raw.githubusercontent.com), and
    // nothing says a child PI *did* register was ever parsed: ChadF's Greatest
    // Hits playlist is feed 7683902 with an empty title, because its XML carries
    // a duplicate `xmlns:podcast`. Before this, the first dropped the child and
    // the second rendered a BLANK CARD — and a collection is exactly where such
    // a feed turns up, since a publisher lists whatever its author lists.
    //
    // PI still WINS wherever it answered usefully: a real feed id, richer
    // metadata, no outbound fetch. `mergeRssOverPi` keeps its id and guid and
    // takes the rest from the feed. `null` from the fallback too is a genuine
    // drop: that URL is not a feed.
    //
    // The PI probe above stays UNCAUGHT, so "PI is down" is still a 5xx and
    // never a page of RSS-derived children pretending PI agreed.
    const needsRss = fromPi
      .map((f, i) => (f === null || piRecordIsBlank(f) ? albumUrls[i] : null))
      .filter((u): u is string => u !== null);
    const rescued = new Map<string, Podcast>();
    if (needsRss.length) {
      const parsed = await Promise.all(
        needsRss.map((url) => getFeedFromRss(url).then((r) => r?.podcast ?? null).catch(() => null)),
      );
      parsed.forEach((p, i) => { if (p) rescued.set(needsRss[i], p); });
    }

    const feeds = fromPi
      .map((f, i) => {
        const rss = rescued.get(albumUrls[i]);
        if (f && !piRecordIsBlank(f)) return f;
        if (f && rss) return mergeRssOverPi(f, rss);
        return f ?? rss ?? null;
      })
      .filter((f): f is Podcast => f !== null);
    return NextResponse.json({ feeds }, { headers: PUBLISHER_CACHE });
  }, 'publisher resolution failed');
}
