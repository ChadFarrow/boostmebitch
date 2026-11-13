import { getFeedFromRss, getPodcastByFeedUrl } from '@/lib/pi';
import { piCouldNotAskStatus } from '@/lib/pi-error';
import { mergeRssOverPi, piRecordIsBlank, mapLimit, PI_FANOUT, FEED_FANOUT } from '@/lib/util';
import type { Podcast } from '@/lib/types';

/**
 * A list of feed URLs → the `Podcast` each one is, Podcast Index first and the
 * feed's own RSS where PI has nothing usable.
 *
 * Server-only (it reaches `lib/pi.ts`). It was the body of `/api/publisher`
 * until a second caller needed exactly this — `lib/curated-roster.ts`, which
 * makes the curated playlists findable by search — and a second copy of a
 * resolution with this many measured failure modes is the drift this repo keeps
 * paying for.
 *
 * `feeds` is **positionally coupled** to `urls`: `null` where neither source
 * produced a usable record. The caller decides what a drop means — the route
 * reports it as `listed` against `feeds.length`, the roster simply has fewer
 * rows.
 *
 * **Throws** when the PI probe fails for any reason other than a rate limit:
 * `getPodcastByFeedUrl` already turns PI's 400/404 into a null, so a throw is PI
 * itself failing, and for `/api/publisher` the resulting 5xx is what trips the
 * client-side breaker in `lib/podcast-meta.ts`.
 */
export interface ResolvedFeeds {
  feeds: (Podcast | null)[];
  /**
   * True when Podcast Index rate limited the probe, so no PI call was made and
   * every record came from RSS — complete and authoritative, but `isPreview`,
   * with no PI id or guid. Never cache an answer built this way.
   */
  couldNotAskPi: boolean;
}

export async function resolveFeedUrls(urls: readonly string[]): Promise<ResolvedFeeds> {
  if (!urls.length) return { feeds: [], couldNotAskPi: false };

  // Probe-first-then-batch, the repo's convention for PI fan-outs: resolve one
  // before firing the rest so a degraded PI costs a single call instead of N.
  //
  // **Except a rate limit, which is not an outage.** docs/feeds.md is explicit
  // that a 429 is never an answer about the data: it belongs in COULD_NOT_ASK,
  // uncached and deliberately NOT tripping the breaker. Rethrowing it here
  // did the opposite — one 429 took the whole collection to a 500 and
  // disabled metadata resolution for the tab, on a page whose children are
  // plain XML on raw.githubusercontent.com that we can read without PI at all.
  // Reported 2026-08-29 with the page dead across repeated reloads while
  // `/api/playlist` served the same feeds from the same process, because that
  // route already swallows this (see `piRecordFor`) and answers from RSS.
  //
  // So a 429/408 skips the PI fan-out entirely — asking N more times cannot
  // help and spends quota we have already been told we do not have — and
  // every child falls through to the RSS repair below. The answer is honest
  // rather than degraded: the feed document is the authority, PI is the
  // accelerator. `isPreview` still tells the client which records came back
  // without a PI id.
  let couldNotAskPi = false;
  let fromPi: (Podcast | null)[];
  try {
    // Probe first, then the rest BOUNDED — the shape `probeThenBatch`
    // documents, hand-rolled here for one reason: that helper swallows a
    // probe throw and returns, and this needs the throw so the 429/408
    // branch below can set `couldNotAskPi`. What it must not do is what it
    // used to: `Promise.all` over `slice(1)` fires up to 99 concurrent PI
    // calls out of one handler, PI rate-limits the burst, and `.catch(null)`
    // files each 429 as "PI does not hold this feed" — dropping real children
    // from the page. That is the exact failure probeThenBatch exists to stop.
    const probe = await getPodcastByFeedUrl(urls[0]);
    const rest = await mapLimit(urls.slice(1), PI_FANOUT, (url) =>
      getPodcastByFeedUrl(url).catch(() => null),
    );
    fromPi = [probe, ...rest];
  } catch (e) {
    // A PI 429/408 means we could not ask, not that there is nothing.
    if (piCouldNotAskStatus(e) === null) throw e;
    couldNotAskPi = true;
    fromPi = urls.map(() => null);
  }

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
  const needsRss = fromPi
    .map((f, i) => (f === null || piRecordIsBlank(f) ? urls[i] : null))
    .filter((u): u is string => u !== null);
  const rescued = new Map<string, Podcast>();
  if (needsRss.length) {
    // Bounded for a different reason than the PI half above: nothing
    // upstream is being protected here, our own memory is. `needsRss` holds
    // every child PI missed — for a publisher feed whose children are all
    // unindexed, every one of them — and each `getFeedFromRss` admits an 8 MB
    // body, so the unbounded version put ~800 MB of feed text in flight from
    // one request. The bounded-cache ceiling limits what is RETAINED; it does
    // nothing about the peak while they are all in hand.
    const parsed = await mapLimit(needsRss, FEED_FANOUT, (url) =>
      getFeedFromRss(url).then((r) => r?.podcast ?? null).catch(() => null),
    );
    parsed.forEach((p, i) => { if (p) rescued.set(needsRss[i], p); });
  }

  const feeds = fromPi.map((f, i) => {
    const rss = rescued.get(urls[i]);
    if (f && !piRecordIsBlank(f)) return f;
    if (f && rss) return mergeRssOverPi(f, rss);
    return f ?? rss ?? null;
  });
  return { feeds, couldNotAskPi };
}
