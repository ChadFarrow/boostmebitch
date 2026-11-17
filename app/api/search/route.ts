import { NextResponse } from 'next/server';
import { searchPodcasts, searchMusicPodcasts, searchPlaylistFeeds, getPodcast, getPodcastByFeedUrl, getFeedFromRss } from '@/lib/pi';
import { searchCuratedPlaylists } from '@/lib/curated-roster';
import type { CuratedHits } from '@/lib/curated-roster';
import {
  curatedNotListed, filterPlaylistsByQuery, matchesSearchType, mergeRssOverPi, mergeSearchLanes,
  parseSearchType, piRecordIsBlank, rankPlaylistsFirst, rankPublishersFirst,
} from '@/lib/util';
import type { SearchType } from '@/lib/util';
import type { Podcast } from '@/lib/types';
import { getPublisherMediums } from '@/lib/musicl-resolver';
import { withErrorHandling, NO_STORE } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';

// `max-age` is the half that was missing, on the same argument `/api/feed`
// records: `s-maxage` alone lets the CDN hold this document while the reader's
// browser re-downloads it every time. A private window SHORTER than the shared
// one introduces no staleness class that was not already permitted — a shared
// cache has been allowed to answer with a 60-second-old copy since this was
// written. Thirty seconds makes searching the same term twice free.
const SEARCH_CACHE = { 'Cache-Control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300' };

/**
 * How many playlist-lane hits may be prepended to a search.
 *
 * Small on purpose: they jump the queue ahead of Podcast Index's own ranking, so
 * a broad word like "music" must not push 50 playlists over the show somebody
 * was actually looking for.
 */
const MAX_PLAYLIST_HITS = 6;

/**
 * How many publisher feeds may be moved to the top of a search.
 *
 * They go above Podcast Index's own leader (`rankPublishersFirst`), so the cap
 * is what keeps a word many publishers share from pushing the show somebody
 * wanted off the first screen. A query naming one artist matches one publisher,
 * or two when a solo name and a band name share it.
 */
const MAX_PUBLISHER_HITS = 3;

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
 *
 * `cacheable: false` answers `no-store`. Two reads set it: the curated lane, when
 * its roster was cold and did not resolve in time (`CuratedHits.answered`), and
 * a publisher feed still unread at its deadline (`withPublisherMediums`). The
 * rows are then missing because nobody asked, and a 60-second CDN copy would
 * serve "0 playlists" for an exact title long after the roster had loaded.
 */
function answer(feeds: unknown[], total: number, type: SearchType, cacheable = true) {
  return NextResponse.json({ feeds, total, type }, { headers: cacheable ? SEARCH_CACHE : NO_STORE });
}

/** The curated lane's answer when it could not be asked at all. */
const CURATED_UNANSWERED: CuratedHits = { feeds: [], answered: false };

/**
 * How many publisher feeds one typed search reads, all at once.
 *
 * A cap on the FAN-OUT, not only on the rows: each one is an outbound RSS read
 * of a URL Podcast Index holds. byterm returned no publisher row at all for
 * `music`, `the` or `everything` on 2026-11-16, and one each for three artist
 * names, so five is room to spare. A publisher past it stays unread, which
 * leaves it under PODCASTS as before.
 */
const MAX_PUBLISHER_READS = 5;

/**
 * How long a typed search waits for those reads.
 *
 * The reads go through `fetchFeedXml`, which caches for five minutes, so this is
 * the cost of a COLD publisher only. Past it the search answers without the
 * unread ones and `no-store`, and the reads finish behind it for the next
 * search — the curated roster's rule (`CuratedHits.answered`).
 */
const PUBLISHER_READ_WAIT_MS = 1500;

/**
 * byterm's rows, each `publisher` row told what it publishes
 * (`publisherMediums`), so `matchesSearchType` can list it under the choice it
 * is FOR. Only a typed search asks; ALL lists every row anyway.
 *
 * `answered` is false when a read was still running at the deadline. A read
 * that FAILED was asked and answered nothing, so it does not clear `answered`:
 * that publisher stays under PODCASTS, and a dead feed must not make every
 * search for its artist uncacheable.
 */
async function withPublisherMediums(feeds: Podcast[]): Promise<{ feeds: Podcast[]; answered: boolean }> {
  const targets = feeds.filter((f) => f.medium === 'publisher' && f.url).slice(0, MAX_PUBLISHER_READS);
  if (!targets.length) return { feeds, answered: true };
  const read = new Map<string, string[] | null>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answered = await Promise.race([
    Promise.all(targets.map(async (f) => {
      read.set(f.url!, await getPublisherMediums(f.url!).catch(() => null));
    })).then(() => true),
    new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), PUBLISHER_READ_WAIT_MS); }),
  ]);
  clearTimeout(timer);
  return {
    feeds: feeds.map((f) => {
      const mediums = f.medium === 'publisher' && f.url ? read.get(f.url) : undefined;
      return mediums?.length ? { ...f, publisherMediums: mediums } : f;
    }),
    answered,
  };
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
      //
      // A PUBLISHER of music is one of byterm's rows, and passes that test only
      // once its feed has said what it publishes (`withPublisherMediums`, read
      // while the music lane is still running). It is lifted to the top as under
      // ALL. The cap comes AFTER the lift: the music lane alone can fill all 50
      // rows, and a cap first would cut the publisher byterm appended after them.
      const [music, { feeds, answered }] = await Promise.all([
        searchMusicPodcasts(query, MAX_TYPED_HITS).catch(() => [] as Awaited<ReturnType<typeof searchMusicPodcasts>>),
        searchPodcasts(query, 50).then(withPublisherMediums),
      ]);
      const merged = mergeSearchLanes(music, feeds, 'music', Infinity);
      return answer(
        rankPublishersFirst(merged, query, MAX_PUBLISHER_HITS).slice(0, MAX_TYPED_HITS),
        feeds.length,
        type,
        answered,
      );
    }, 'search failed');
  }

  if (type === 'playlist') {
    return withErrorHandling(async () => {
      // The same two lanes `rankPlaylistsFirst` merges, minus the promotion: with
      // nothing but playlists on screen there is no PI leader to hold back and
      // nothing to lift anything above. byterm's hits come first because they are
      // ranked answers rather than substring matches over a roster, which is the
      // precedence that ranker already uses.
      //
      // The CURATED lane comes last: the playlists `/playlists` lists, which
      // includes ones Podcast Index has not indexed yet (#529). It adds only
      // what neither PI lane returned — `curatedNotListed` dedupes by feed URL
      // as well as id, because an RSS-built record's id is never PI's.
      //
      // A PUBLISHER of playlists (ChadF's lists 14 `musicL` feeds) joins them
      // through `matchesSearchType`, once its feed has said what it publishes,
      // and is lifted to the top as under ALL — capped after the lift, as under
      // MUSIC. Only byterm's publisher rows are offered: its other rows reach
      // this list through `filterPlaylistsByQuery` alone.
      const [{ feeds, answered }, rosterHits, curatedHits] = await Promise.all([
        searchPodcasts(query, 50).then(withPublisherMediums),
        searchPlaylistFeeds(query, MAX_TYPED_HITS).catch(() => [] as Awaited<ReturnType<typeof searchPlaylistFeeds>>),
        searchCuratedPlaylists(query, MAX_TYPED_HITS).catch(() => CURATED_UNANSWERED),
      ]);
      const fromByterm = filterPlaylistsByQuery(feeds, query, MAX_TYPED_HITS);
      const curated = curatedNotListed(curatedHits.feeds, [...fromByterm, ...rosterHits]);
      const publishers = feeds.filter((f) => f.medium === 'publisher');
      const merged = mergeSearchLanes(fromByterm, [...rosterHits, ...curated, ...publishers], 'playlist', Infinity);
      return answer(
        rankPublishersFirst(merged, query, MAX_PUBLISHER_HITS).slice(0, MAX_TYPED_HITS),
        feeds.length,
        type,
        curatedHits.answered && answered,
      );
    }, 'search failed');
  }

  if (type === 'podcast') {
    return withErrorHandling(async () => {
      // One lane: there is no `/podcasts/bymedium` roster worth holding for this
      // one. `matchesSearchType('podcast')` is a RESIDUAL test — "not music, not
      // a list medium" — because Podcast Index leaves the tag blank on most of
      // what it holds, and an inclusion test would silently empty the chip.
      //
      // A PUBLISHER is here when its feed lists a podcast, or when what it
      // lists is unknown (`matchesSearchType`); a publisher of music only is
      // under MUSIC instead. It is lifted as under ALL: first wherever it is
      // shown.
      const { feeds, answered } = await searchPodcasts(query, 50).then(withPublisherMediums);
      return answer(
        rankPublishersFirst(feeds.filter((f) => matchesSearchType(f, 'podcast')), query, MAX_PUBLISHER_HITS),
        feeds.length,
        type,
        answered,
      );
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
    //
    // A third lane, the CURATED one, holds the playlists `/playlists` lists —
    // including ones PI has not indexed yet, which no PI lane can return (#529).
    // Same accelerator contract: `[]` on every failure. It joins the roster
    // lane's hits, after them, minus anything a PI lane already returned.
    const [feeds, rosterHits, curatedHits] = await Promise.all([
      searchPodcasts(query, 50),
      searchPlaylistFeeds(query, MAX_PLAYLIST_HITS).catch(() => [] as Awaited<ReturnType<typeof searchPlaylistFeeds>>),
      searchCuratedPlaylists(query, MAX_PLAYLIST_HITS).catch(() => CURATED_UNANSWERED),
    ]);
    const curated = curatedNotListed(curatedHits.feeds, [...feeds, ...rosterHits]);

    // Matching playlists lifted above the results PI buried them under, without
    // displacing PI's own leader. The whole rule — and the measurements behind
    // it — lives in `rankPlaylistsFirst`, which `check:musicl` pins against the
    // real `mutton` and `flowgnar` responses.
    //
    // Then a matching PUBLISHER feed goes above all of it, PI's leader
    // included: it is the artist's whole catalogue, and PI ranks it under every
    // album it lists (`longy`: row 37 of 40). `rankPublishersFirst` holds the
    // rule and the measurements, pinned by `check:musicl`.
    const ranked = rankPublishersFirst(
      rankPlaylistsFirst(feeds, [...rosterHits, ...curated], query, MAX_PLAYLIST_HITS),
      query,
      MAX_PUBLISHER_HITS,
    );
    return answer(ranked, ranked.length, 'all', curatedHits.answered);
  }, 'search failed');
}
