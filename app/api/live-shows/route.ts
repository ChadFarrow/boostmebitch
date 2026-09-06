import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import {
  PiHttpError,
  getGlobalLiveItems,
  getLiveItemsFromRssDetailed,
  getPodcast,
} from '@/lib/pi';
import { compareLiveShows, mapLimit, mergeLiveOverPi, FEED_FANOUT, PI_FANOUT } from '@/lib/util';
import type { Episode, LiveShow, Podcast } from '@/lib/types';

/**
 * Every `<podcast:liveItem>` on air right now, across every feed — the data
 * behind `/live`.
 *
 * WHY A SECOND LIVE ROUTE. `/api/live-status` answers "is THIS show still on
 * air", for a feed the reader already has open, and is RSS-only. This one
 * answers "what is on air anywhere", which nothing could ask before: a
 * `<podcast:liveItem>` was visible only after you had guessed which show to
 * open.
 *
 * ROSTER, THEN TRUTH. Podcast Index is the only global index of live items, and
 * `getGlobalLiveItems` is one call that this app was already making and
 * throwing away. But PI is a poor authority on any one show's status — measured
 * 2026-08-07 returning ZERO live items for a feed actively publishing
 * `status="live"`, and it equally keeps rows for broadcasts that have ended. So
 * PI picks the candidates and each publisher's own RSS decides what is true,
 * which is the same precedence `/api/live-status` applies one feed at a time.
 *
 * That verification pass pays for itself twice: it is also the ONLY source of
 * upcoming items. PI indexes currently-broadcasting rows only, while
 * `parseRssLiveItems` returns `pending` and `live` together — so every feed we
 * read for verification hands back its schedule for free. There is no global
 * source for a pending item on a feed that is not already live, and no endpoint
 * that would provide one; the page is worded accordingly.
 */

// 30 s rather than /api/live-status's 10 s. That route is a badge on a page the
// reader is already looking at, where a stale PENDING locks them out of a
// broadcast that has started. This is a browsing surface reached by tapping a
// tab, and the window is what collapses two fan-outs across every visitor
// inside it. Still far under the 45 s client poll, so a refresh is never served
// its own previous answer.
const LIVE_SHOWS_CACHE = { 'Cache-Control': 'public, max-age=30, s-maxage=30' };

// An answer PI could not be fully asked for is never cached — the same rule
// /api/publisher and /api/playlist apply. Caching it would serve the thin
// version for the whole window after PI came back.
const NO_STORE = { 'Cache-Control': 'no-store' };

// The per-caller freshness override on the shared RSS cache, matching
// /api/live-status. A live item's status is the one field on a feed that goes
// stale inside a minute, and the 60 s window /api/feed depends on must not be
// dragged down to serve this route.
const LIVE_XML_MAX_AGE_MS = 10_000;

/**
 * Hard ceiling on how many feeds one request will verify.
 *
 * Sized against the CLOCK, not against taste. `PI_TIMEOUT_MS` is 8 s and no
 * route here sets `maxDuration`, so the whole handler lives inside the
 * platform's default ceiling. The worst case is
 * `ceil(N / PI_FANOUT) × 8s + ceil(N / FEED_FANOUT) × 8s` — at 24 that is four
 * PI rounds plus three RSS rounds, against a realistic sub-second run. PI can
 * return up to 1000 rows, and a capped COUNT is not a capped FAN-OUT, so both
 * bounds are here: this slice, and `mapLimit` on each stage.
 *
 * Going over is reported as `truncated` rather than hidden. Raise it only after
 * measuring a real roster.
 */
const MAX_LIVE_FEEDS = 24;

export async function GET(req: Request) {
  // 60/min like the other two live routes, because the page polls.
  const limited = rateLimit(req, 'live-shows', 60);
  if (limited) return limited;

  return withErrorHandling(async () => {
    // The probe, deliberately uncaught. If PI itself is unreachable or rate
    // limiting, `withErrorHandling` turns that into 429/408/500 — never an
    // empty 200, which would tell the page nobody is broadcasting. An empty
    // list is a CLAIM, and this is the layer that must not make it falsely.
    const roster = await getGlobalLiveItems();

    const byFeed = new Map<number, Episode[]>();
    for (const e of roster) {
      const id = Number(e.feedId);
      if (!Number.isInteger(id) || id <= 0) continue;
      const bucket = byFeed.get(id);
      if (bucket) bucket.push(e);
      else byFeed.set(id, [e]);
    }

    const allFeedIds = [...byFeed.keys()];
    const feedIds = allFeedIds.slice(0, MAX_LIVE_FEEDS);
    const truncated = allFeedIds.length > feedIds.length;

    if (!feedIds.length) {
      // PI answered, and it genuinely holds nothing live. That IS an answer, so
      // it is cacheable — unlike every branch where we could not ask.
      return NextResponse.json(
        { items: [], unverifiedFeeds: 0, truncated: false },
        { headers: LIVE_SHOWS_CACHE },
      );
    }

    // Stage 1 (PI, bounded by PI_FANOUT — their rate limiter is what is being
    // respected). The roster names feed IDs but not feed URLs, and the RSS pass
    // below cannot run without one.
    //
    // A 429 here is not an outage and must not read as one: it means the rest
    // of this list is unverifiable, not that those shows ended. Every row
    // survives on PI's word, flagged unverified, and the answer is `no-store`.
    let couldNotAskPi = false;
    let podcasts: (Podcast | null)[];
    try {
      podcasts = await mapLimit(feedIds, PI_FANOUT, (id) => getPodcast(id));
    } catch (e) {
      if (!(e instanceof PiHttpError) || (e.status !== 429 && e.status !== 408)) throw e;
      couldNotAskPi = true;
      podcasts = feedIds.map(() => null);
    }

    // Stage 2 (RSS, bounded by FEED_FANOUT — this bound is about OUR heap:
    // every entry is an 8 MB-capped read of a URL that came from feed data).
    // Only feeds PI could name a URL for are readable at all.
    const readable = feedIds
      .map((id, i) => ({ id, podcast: podcasts[i] }))
      .filter((f): f is { id: number; podcast: Podcast & { url: string } } => !!f.podcast?.url);

    const reads = await mapLimit(readable, FEED_FANOUT, (f) =>
      getLiveItemsFromRssDetailed(f.podcast.url, f.id, f.podcast.podcastGuid, {
        maxAgeMs: LIVE_XML_MAX_AGE_MS,
      }).catch(() => ({ ok: false, items: [] as Episode[] })),
    );
    const readByFeed = new Map(readable.map((f, i) => [f.id, reads[i]]));

    const items: LiveShow[] = [];
    let unverifiedFeeds = 0;

    feedIds.forEach((id, i) => {
      const podcast = podcasts[i];
      const piRows = byFeed.get(id) ?? [];
      // A feed with no readable URL gets `ok: false` — which is the honest
      // answer, and the one `mergeLiveOverPi` treats as authoritative about
      // nothing. PI's rows survive rather than being dropped.
      const read = readByFeed.get(id) ?? { ok: false, items: [] as Episode[] };
      const { items: merged, verified } = mergeLiveOverPi(piRows, read);
      if (!verified) unverifiedFeeds += 1;
      for (const e of merged) {
        if (e.liveStatus !== 'live' && e.liveStatus !== 'pending') continue;
        items.push({
          guid: e.guid,
          title: e.title,
          description: e.description,
          image: e.image ?? e.feedImage ?? podcast?.image ?? podcast?.artwork,
          enclosureUrl: e.enclosureUrl ?? '',
          enclosureType: e.enclosureType,
          liveStatus: e.liveStatus,
          liveStartTime: e.liveStartTime,
          value: e.value ?? null,
          feedId: id,
          feedTitle: e.feedTitle ?? podcast?.title,
          feedImage: e.feedImage ?? podcast?.image ?? podcast?.artwork,
          feedUrl: podcast?.url,
          podcastGuid: e.podcastGuid ?? podcast?.podcastGuid,
          verified,
        });
      }
    });

    items.sort(compareLiveShows);

    return NextResponse.json(
      { items, unverifiedFeeds, truncated },
      { headers: couldNotAskPi ? NO_STORE : LIVE_SHOWS_CACHE },
    );
  }, 'live-shows fetch failed');
}
