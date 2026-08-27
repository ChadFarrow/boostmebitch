import { NextResponse } from 'next/server';
import { searchPodcasts, searchPlaylistFeeds, getPodcast, getPodcastByFeedUrl, getFeedFromRss } from '@/lib/pi';
import { mergeRssOverPi, piRecordIsBlank, rankPlaylistsFirst } from '@/lib/util';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';

const SEARCH_CACHE = { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' };

/**
 * How many playlist-lane hits may be prepended to a search.
 *
 * Small on purpose: they jump the queue ahead of Podcast Index's own ranking, so
 * a broad word like "music" must not push 50 playlists over the show somebody
 * was actually looking for.
 */
const MAX_PLAYLIST_HITS = 6;

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
      // PI first, but a PI FAILURE must not defeat the RSS fallback.
      //
      // `getPodcastByFeedUrl` turns PI's 400/404 "feed url not found" into null,
      // and only that null used to reach the fallback — an auth error or a 5xx
      // propagated straight out as a 500. So the one input where we need PI
      // least (the user handed us the feed URL; we can read it ourselves) was
      // the one that failed hardest when PI was down. Measured: pasting a
      // playlist URL answered 500 while /api/playlist served the same feed's
      // 1217 tracks from the same process.
      //
      // The PI error is REMEMBERED rather than swallowed: if the RSS read also
      // comes up empty we rethrow it, so a genuine PI outage still surfaces as a
      // 5xx and still trips the client-side breaker, and "PI is down" never
      // renders as "no such feed". A successful RSS parse means the user got
      // what they asked for, and there is nothing to report.
      let piHit = null;
      let piError: unknown;
      try {
        piHit = await getPodcastByFeedUrl(query);
      } catch (e) {
        piError = e;
      }
      // A PI hit with a BLANK TITLE is not a usable answer — see
      // `piRecordIsBlank`. Returned as-is it is an EMPTY ROW, which is
      // indistinguishable from the feed not being there at all: "I don't see it
      // listed", for a feed whose URL the user just pasted.
      if (!piRecordIsBlank(piHit)) {
        return NextResponse.json({ feeds: [piHit] }, { headers: SEARCH_CACHE });
      }
      const parsed = await getFeedFromRss(query).catch(() => null);
      if (piHit && parsed) {
        return NextResponse.json(
          { feeds: [mergeRssOverPi(piHit, parsed.podcast)] },
          { headers: SEARCH_CACHE },
        );
      }
      if (piHit) return NextResponse.json({ feeds: [piHit] }, { headers: SEARCH_CACHE });
      if (parsed) return NextResponse.json({ feeds: [parsed.podcast] }, { headers: SEARCH_CACHE });
      if (piError) throw piError;
      return NextResponse.json({ feeds: [] }, { headers: SEARCH_CACHE });
    }, 'feed url resolve failed');
  }

  return withErrorHandling(async () => {
    // Two lanes, in parallel. `/search/byterm` is the index's own ranked answer
    // and stays authoritative; the playlist lane exists because that endpoint
    // has **no medium parameter**, so a `musicL` or `podcastL` feed it ranks
    // poorly is unreachable by keyword however the user phrases the query.
    //
    // The lane is an ACCELERATOR and never a dependency: `searchPlaylistFeeds`
    // answers [] for every failure and for a cold roster, so a search can only
    // ever be as good as it was before this existed — never broken by it.
    const [feeds, rosterHits] = await Promise.all([
      searchPodcasts(query, 50),
      searchPlaylistFeeds(query, MAX_PLAYLIST_HITS).catch(() => [] as Awaited<ReturnType<typeof searchPlaylistFeeds>>),
    ]);

    // Matching playlists lifted above the results PI buried them under, without
    // displacing PI's own leader. The whole rule — and the measurements behind
    // it — lives in `rankPlaylistsFirst`, which `check:musicl` pins against the
    // real `mutton` and `flowgnar` responses.
    return NextResponse.json(
      { feeds: rankPlaylistsFirst(feeds, rosterHits, query, MAX_PLAYLIST_HITS) },
      { headers: SEARCH_CACHE },
    );
  }, 'search failed');
}
