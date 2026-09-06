import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import {
  PiHttpError,
  getGlobalLiveItems,
  getLiveItemsFromRssDetailed,
  getPodcast,
} from '@/lib/pi';
import { createBoundedCache } from '@/lib/bounded-cache';
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

/**
 * The header for an answer that depends on WHO ASKED.
 *
 * `LIVE_SHOWS_CACHE` carries `s-maxage`, which is an instruction to a SHARED
 * cache. The moment a response includes rows read from the caller's own
 * favorited feeds it is no longer the same document for everybody, so it must
 * not sit in one. The CDN keys by URL and the favorites ride in the query, so
 * a cross-user hit would already be unlikely — but "unlikely" is not the test
 * for personal data in a shared cache, and `private` costs nothing: the
 * browser still caches it for the same 30 s, which is all this needed.
 */
const PERSONAL_CACHE = { 'Cache-Control': 'private, max-age=30' };

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

/**
 * How many of the caller's own favorited feeds this will additionally read.
 *
 * Separate from `MAX_LIVE_FEEDS` because it answers a different question. That
 * one bounds a list Podcast Index chose; this one bounds a list the VISITOR
 * chose, which is attacker-controlled in exactly the same way once it arrives
 * as a query parameter — a caller can name any 12 feed ids, favorited or not.
 * Both walks are bounded again by `mapLimit`, because a capped count is not a
 * capped fan-out.
 *
 * Kept small on purpose: these feeds are read on top of whatever PI reported
 * live, so the two caps add up inside one function's time budget.
 */
const MAX_FAVORITE_FEEDS = 20;

/**
 * How many recently-live feeds to re-read. See `rememberedFeeds` below.
 *
 * Cheaper per feed than either cap above, because a remembered feed already
 * carries its URL and skips the Podcast Index stage entirely — but it still
 * costs an RSS read, and those are what `FEED_FANOUT` is protecting the heap
 * from, so it is bounded like everything else.
 */
const MAX_REMEMBERED_FEEDS = 10;

/** How long a feed stays worth re-reading after it was last seen live. */
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;

/** The most feeds the memory below will hold. */
const SEEN_MAX = 60;

interface SeenFeed {
  id: number;
  url: string;
  podcastGuid?: string;
  /** unix ms, when this feed was last observed carrying a LIVE item. */
  lastSeen: number;
}

/**
 * The feeds this server has recently watched go live.
 *
 * WHY IT EXISTS. Podcast Index indexes currently-broadcasting rows only, and
 * `/podcasts/bytag` supports just `podcast-value` and `podcast-valueTimeSplit`
 * — there is no "feeds that publish live items" tag anywhere in the API. So
 * there is no global roster to ask for, and without one the Upcoming list could
 * only ever describe shows already on air.
 *
 * This builds the roster from observation instead: every request learns which
 * feeds PI says are live, and those are worth re-reading tomorrow, because a
 * show that broadcast yesterday is exactly the kind that publishes next week's
 * `<podcast:liveItem status="pending">`. It costs nothing to gather — the
 * information was already in hand — and it needs no hand-maintained list that
 * somebody has to notice has gone stale.
 *
 * **It is per server instance and that is a real limitation, not a detail.**
 * Module state does not survive a cold start and is not shared between
 * instances, so coverage is patchy and resets. It is strictly additive — every
 * row it produces is still read from the publisher's own feed and merged by
 * `mergeLiveOverPi` — so the failure mode is a shorter list, never a wrong one.
 * The version that does not have this caveat is a background crawler with
 * durable storage; see docs/feeds.md.
 *
 * ONE ENTRY holding the list, the shape `playlistRoster` uses, because
 * `createBoundedCache` has no way to enumerate its keys. The cache's own
 * horizon is deliberately longer than `SEEN_TTL_MS`: entries are aged out
 * individually on read, so the horizon is only a backstop against the whole
 * list being kept alive forever by a server nobody restarts.
 */
const seenLiveCache = createBoundedCache<SeenFeed[]>({
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxEntries: 1,
});
const SEEN_KEY = 'seen';

function rememberedFeeds(now: number): SeenFeed[] {
  const hit = seenLiveCache.get(SEEN_KEY, now);
  if (!hit) return [];
  return hit.value.filter((f) => now - f.lastSeen < SEEN_TTL_MS);
}

function rememberLiveFeeds(fresh: SeenFeed[], now: number): void {
  if (!fresh.length) return;
  const byId = new Map<number, SeenFeed>();
  for (const f of rememberedFeeds(now)) byId.set(f.id, f);
  // Fresh wins: it carries the newer `lastSeen` and the URL PI just gave us.
  for (const f of fresh) byId.set(f.id, f);
  const list = [...byId.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, SEEN_MAX);
  seenLiveCache.set(SEEN_KEY, list, now);
}

export async function GET(req: Request) {
  // 60/min like the other two live routes, because the page polls.
  const limited = rateLimit(req, 'live-shows', 60);
  if (limited) return limited;
  const { searchParams } = new URL(req.url);

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

    const rosterIds = [...byFeed.keys()];
    const fromRoster = rosterIds.slice(0, MAX_LIVE_FEEDS);
    const truncated = rosterIds.length > fromRoster.length;

    /**
     * The caller's own favorited feeds, read on top of the roster.
     *
     * WHY THIS PARAMETER EXISTS. Podcast Index indexes currently-broadcasting
     * rows only, so the roster alone can never surface a `pending` item, and
     * the verification pass only reads feeds that are already live — meaning
     * "Upcoming" could show the next episode of a show on air this second, and
     * nothing else. A roster of feeds worth reading has to come from somewhere,
     * and the visitor's own favorites are the one source that is already known,
     * already bounded, and already sent to this server by
     * `/api/by-guid/batch` during favorites hydration.
     *
     * It also repairs the failure this route could not otherwise address at
     * all. PI lags in BOTH directions, and the direction RSS verification
     * cannot fix is the false NEGATIVE — a show genuinely live that PI does not
     * list, which is precisely what was measured on 2026-08-07. Reading a
     * favorited feed directly finds it, so a show you follow appears whether or
     * not PI has noticed it yet.
     *
     * Treated as untrusted input, because it is: anyone can name any ids. They
     * are validated as positive integers, deduped against the roster, and
     * capped — the same treatment `/api/by-guid/batch` gives its guid list.
     */
    const requested = (searchParams.get('feeds') ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    const seen = new Set(fromRoster);
    const fromFavorites: number[] = [];
    for (const id of requested) {
      if (seen.has(id)) continue;
      seen.add(id);
      fromFavorites.push(id);
      if (fromFavorites.length >= MAX_FAVORITE_FEEDS) break;
    }
    // Feeds this server watched go live recently. They already carry a URL, so
    // they skip the Podcast Index stage below entirely — which is what makes
    // them the cheapest of the three sources and why they are read last.
    const now = Date.now();
    const remembered = rememberedFeeds(now)
      .filter((f) => !seen.has(f.id))
      .slice(0, MAX_REMEMBERED_FEEDS);
    for (const f of remembered) seen.add(f.id);

    const knownUrl = new Map(remembered.map((f) => [f.id, f]));
    const feedIds = [...fromRoster, ...fromFavorites, ...remembered.map((f) => f.id)];
    // Personal the moment one favorited feed was read — see PERSONAL_CACHE.
    // The remembered set is server state, identical for every caller, so it
    // does NOT make the answer personal.
    const personal = fromFavorites.length > 0;

    if (!feedIds.length) {
      // PI answered, it genuinely holds nothing live, and the caller named no
      // feeds of their own. That IS an answer, so it is cacheable — unlike
      // every branch where we could not ask.
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
    //
    // Only feeds whose URL is not already in hand are asked for. A remembered
    // feed was resolved on an earlier request and kept its URL, so re-reading
    // it costs one RSS fetch and nothing upstream.
    const needsPi = feedIds.filter((id) => !knownUrl.has(id));
    let couldNotAskPi = false;
    const piByFeed = new Map<number, Podcast>();
    try {
      const resolved = await mapLimit(needsPi, PI_FANOUT, (id) => getPodcast(id));
      resolved.forEach((p, i) => { if (p) piByFeed.set(needsPi[i], p); });
    } catch (e) {
      if (!(e instanceof PiHttpError) || (e.status !== 429 && e.status !== 408)) throw e;
      couldNotAskPi = true;
    }

    // Stage 2 (RSS, bounded by FEED_FANOUT — this bound is about OUR heap:
    // every entry is an 8 MB-capped read of a URL that came from feed data).
    // Only feeds PI could name a URL for are readable at all.
    const readable = feedIds
      .map((id) => {
        const known = knownUrl.get(id);
        const pi = piByFeed.get(id);
        const url = known?.url ?? pi?.url;
        return url ? { id, url, podcastGuid: known?.podcastGuid ?? pi?.podcastGuid } : null;
      })
      .filter((f): f is { id: number; url: string; podcastGuid: string | undefined } => f !== null);

    const reads = await mapLimit(readable, FEED_FANOUT, (f) =>
      getLiveItemsFromRssDetailed(f.url, f.id, f.podcastGuid, {
        maxAgeMs: LIVE_XML_MAX_AGE_MS,
      }).catch(() => ({ ok: false, items: [] as Episode[] })),
    );
    const readByFeed = new Map(readable.map((f, i) => [f.id, reads[i]]));
    const urlByFeed = new Map(readable.map((f) => [f.id, f.url]));

    const items: LiveShow[] = [];
    let unverifiedFeeds = 0;

    const wentLive: SeenFeed[] = [];

    feedIds.forEach((id) => {
      const podcast = piByFeed.get(id);
      const piRows = byFeed.get(id) ?? [];
      // A feed with no readable URL gets `ok: false` — which is the honest
      // answer, and the one `mergeLiveOverPi` treats as authoritative about
      // nothing. PI's rows survive rather than being dropped.
      const read = readByFeed.get(id) ?? { ok: false, items: [] as Episode[] };
      const { items: merged, verified } = mergeLiveOverPi(piRows, read);
      // Only a feed PI actually listed can be "unchecked". For a favorited feed
      // PI never mentioned, an unreadable RSS means we learned nothing — and
      // there is no claim on screen for that to qualify. Counting it would tell
      // the reader that N shows "may have finished" when no show was ever
      // reported in the first place.
      if (!verified && piRows.length) unverifiedFeeds += 1;
      const url = urlByFeed.get(id);
      for (const e of merged) {
        if (e.liveStatus !== 'live' && e.liveStatus !== 'pending') continue;
        // Remember the feed the moment we see it actually broadcasting — a
        // LIVE item, never a pending one. Pending alone would make a feed
        // remember itself forever off its own schedule, which is a loop, not
        // an observation.
        //
        // ONLY feeds Podcast Index's own roster named (`piRows.length`). The
        // memory is server-wide state that shapes what every visitor sees, and
        // the other two sources are not public: seeding it from a caller's
        // favorites would let one person's private list change another
        // person's page, which is an inference about that list however weak.
        // PI's roster is a public answer, so anything derived from it is too.
        if (e.liveStatus === 'live' && url && piRows.length && !wentLive.some((f) => f.id === id)) {
          wentLive.push({ id, url, podcastGuid: e.podcastGuid ?? podcast?.podcastGuid, lastSeen: now });
        }
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
          feedUrl: url,
          podcastGuid: e.podcastGuid ?? podcast?.podcastGuid,
          verified,
        });
      }
    });

    items.sort(compareLiveShows);
    rememberLiveFeeds(wentLive, now);

    return NextResponse.json(
      { items, unverifiedFeeds, truncated },
      { headers: couldNotAskPi ? NO_STORE : personal ? PERSONAL_CACHE : LIVE_SHOWS_CACHE },
    );
  }, 'live-shows fetch failed');
}
