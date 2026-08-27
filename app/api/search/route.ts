import { NextResponse } from 'next/server';
import { searchPodcasts, searchMusicPodcasts, searchPlaylistFeeds, getPodcast, getPodcastByFeedUrl, getFeedFromRss } from '@/lib/pi';
import {
  filterPlaylistsByQuery, matchesSearchType, mergeRssOverPi, mergeSearchLanes,
  parseSearchType, piRecordIsBlank, rankPlaylistsFirst,
} from '@/lib/util';
import type { SearchType } from '@/lib/util';
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

/**
 * How many rows a TYPED search returns.
 *
 * Matches the `max` byterm is asked for, because a typed lane is a narrowing of
 * that same set rather than a promotion within it — `MAX_PLAYLIST_HITS` is small
 * precisely because those six jump the queue ahead of Podcast Index's ranking,
 * and nothing here jumps anything.
 */
const MAX_TYPED_HITS = 50;

/**
 * One response shape for every branch.
 *
 * `type` is echoed back as the type that was actually APPLIED, which is not
 * always the one that was asked for — the feed-URL branch is an exact lookup and
 * ignores it. The client words its empty state from this field, so echoing the
 * request instead would let the screen name a filter that never ran.
 *
 * `total` is the UNFILTERED count for the same query, and it is what stops a
 * narrowed empty result from asserting that Podcast Index holds nothing: "no
 * albums match, 23 results across all types" is a different sentence from "no
 * results". It costs nothing — every typed lane runs byterm anyway.
 */
function answer(feeds: unknown[], total: number, type: SearchType) {
  return NextResponse.json({ feeds, total, type }, { headers: SEARCH_CACHE });
}

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
  // An ALLOWLIST, never the raw parameter: this value decides which Podcast
  // Index endpoint runs, so an unvalidated one is a caller-supplied string
  // reaching a URL we build. Anything unrecognized is `'all'`, which hides
  // nothing. `'npub'` is an input mode and never arrives here — if it somehow
  // does, it falls through the switch below to the unfiltered answer rather than
  // to an empty one.
  const type = parseSearchType(searchParams.get('type'));
  if (!q) return answer([], 0, type);
  // Cap rather than reject — friendlier for a type-ahead box.
  const query = q.slice(0, 200);

  // Feed-URL input: check Podcast Index first; if it doesn't index the feed,
  // parse the raw RSS so the publisher can preview it before submitting to PI.
  //
  // The selector is IGNORED here, and every answer echoes `'all'`. A pasted URL
  // names one feed, so this is a lookup rather than a search: hiding the feed
  // somebody just handed us because its medium disagrees with a chip would be a
  // refusal with no way to see why. Echoing the applied type keeps the screen
  // honest about which of the two ran.
  if (looksLikeFeedUrl(query)) {
    return withErrorHandling(async () => {
      // A Podcast Index show-page link resolves by its numeric feed id.
      const piId = parsePodcastIndexFeedId(query);
      if (piId) {
        const p = await getPodcast(piId);
        return answer(p ? [p] : [], p ? 1 : 0, 'all');
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
        return answer([piHit], 1, 'all');
      }
      const parsed = await getFeedFromRss(query).catch(() => null);
      if (piHit && parsed) {
        return answer([mergeRssOverPi(piHit, parsed.podcast)], 1, 'all');
      }
      if (piHit) return answer([piHit], 1, 'all');
      if (parsed) return answer([parsed.podcast], 1, 'all');
      if (piError) throw piError;
      return answer([], 0, 'all');
    }, 'feed url resolve failed');
  }

  // The selector picks the LANES, never a filter over one lane's output.
  //
  // That distinction is the whole feature. `/search/byterm` has no medium
  // parameter, so narrowing its 50 ranked rows on this side cannot reach an album
  // it ranked at position 60 — and an absent row is indistinguishable from a feed
  // Podcast Index does not hold. A narrowing control that reports "no results"
  // about a record the index has would reintroduce, one chip over, exactly the
  // failure the playlist lane exists to fix.
  //
  // `type` is validated above, so this switch is total over an allowlist. Every
  // secondary lane fails soft: it can only ever make an answer SHORTER than
  // byterm's, never absent.
  if (type === 'music') {
    return withErrorHandling(async () => {
      // `/search/music/byterm` answered the medium question itself, so its rows
      // are trusted as music without a re-check — PI's own `medium` field can
      // contradict the feed (see `piRecordIsBlank`), and re-filtering this lane
      // would discard the rows it was asked for. byterm's rows carry no such
      // answer and must pass `matchesSearchType`. `mergeSearchLanes` owns both
      // halves of that rule.
      const [music, feeds] = await Promise.all([
        searchMusicPodcasts(query, MAX_TYPED_HITS).catch(() => [] as Awaited<ReturnType<typeof searchMusicPodcasts>>),
        searchPodcasts(query, 50),
      ]);
      return answer(mergeSearchLanes(music, feeds, 'music', MAX_TYPED_HITS), feeds.length, type);
    }, 'search failed');
  }

  if (type === 'playlist') {
    return withErrorHandling(async () => {
      // The same two lanes `rankPlaylistsFirst` merges, minus the promotion: with
      // nothing but playlists on screen there is no PI leader to hold back and
      // nothing to lift anything above. byterm's hits come first because they are
      // ranked answers rather than substring matches over a roster, which is the
      // precedence that ranker already uses.
      const [feeds, rosterHits] = await Promise.all([
        searchPodcasts(query, 50),
        searchPlaylistFeeds(query, MAX_TYPED_HITS).catch(() => [] as Awaited<ReturnType<typeof searchPlaylistFeeds>>),
      ]);
      const fromByterm = filterPlaylistsByQuery(feeds, query, MAX_TYPED_HITS);
      return answer(
        mergeSearchLanes(fromByterm, rosterHits, 'playlist', MAX_TYPED_HITS),
        feeds.length,
        type,
      );
    }, 'search failed');
  }

  if (type === 'podcast') {
    return withErrorHandling(async () => {
      // One lane: there is no `/podcasts/bymedium` roster worth holding for this
      // one. `matchesSearchType('podcast')` is a RESIDUAL test — "not music, not
      // a list medium" — because Podcast Index leaves the tag blank on most of
      // what it holds, and an inclusion test would silently empty the chip.
      const feeds = await searchPodcasts(query, 50);
      return answer(feeds.filter((f) => matchesSearchType(f, 'podcast')), feeds.length, type);
    }, 'search failed');
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
    const ranked = rankPlaylistsFirst(feeds, rosterHits, query, MAX_PLAYLIST_HITS);
    return answer(ranked, ranked.length, 'all');
  }, 'search failed');
}
