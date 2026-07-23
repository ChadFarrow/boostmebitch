import { NextResponse } from 'next/server';
import { searchPodcasts, getPodcast, getPodcastByFeedUrl, getFeedFromRss } from '@/lib/pi';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';

const SEARCH_CACHE = { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' };

// A pasted feed URL — parseable http(s) URL with a dotted hostname. The parse
// guard keeps a half-typed "https://" from firing a PI + outbound RSS fetch on
// every keystroke (the search box already debounces on top of this).
function looksLikeFeedUrl(q: string): boolean {
  if (!/^https?:\/\//i.test(q)) return false;
  try {
    return new URL(q).hostname.includes('.');
  } catch {
    return false;
  }
}

// A pasted Podcast Index show page (podcastindex.org/podcast/<id>). The numeric
// path segment IS the PI feed id, so we can resolve it straight to the feed
// rather than treating the HTML page as an RSS feed (which finds nothing).
function parsePodcastIndexFeedId(q: string): number | null {
  const m = /^https?:\/\/(?:www\.)?podcastindex\.org\/podcast\/(\d+)\b/i.exec(q);
  return m ? Number(m[1]) : null;
}

export async function GET(req: Request) {
  const limited = rateLimit(req, 'search', 60);
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim();
  if (!q) return NextResponse.json({ feeds: [] }, { headers: SEARCH_CACHE });
  // Cap rather than reject — friendlier for a type-ahead box.
  const query = q.slice(0, 200);

  // Feed-URL input: check Podcast Index first; if it doesn't index the feed,
  // parse the raw RSS so the publisher can preview it before submitting to PI.
  if (looksLikeFeedUrl(query)) {
    return withErrorHandling(async () => {
      // A Podcast Index show-page link resolves by its numeric feed id.
      const piId = parsePodcastIndexFeedId(query);
      if (piId) {
        const p = await getPodcast(piId);
        return NextResponse.json({ feeds: p ? [p] : [] }, { headers: SEARCH_CACHE });
      }
      const piHit = await getPodcastByFeedUrl(query);
      if (piHit) return NextResponse.json({ feeds: [piHit] }, { headers: SEARCH_CACHE });
      const parsed = await getFeedFromRss(query);
      return NextResponse.json({ feeds: parsed ? [parsed.podcast] : [] }, { headers: SEARCH_CACHE });
    }, 'feed url resolve failed');
  }

  return withErrorHandling(async () => {
    const feeds = await searchPodcasts(query, 50);
    return NextResponse.json({ feeds }, { headers: SEARCH_CACHE });
  }, 'search failed');
}
