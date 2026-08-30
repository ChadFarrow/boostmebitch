import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { getPublisherAlbumUrls } from '@/lib/musicl-resolver';
import { PiHttpError, getFeedFromRss, getPodcastByFeedUrl } from '@/lib/pi';
import { mergeRssOverPi, piRecordIsBlank } from '@/lib/util';
import type { Podcast } from '@/lib/types';

// Publisher feeds are effectively static — new albums appear rarely — and this
// is by far the most expensive route here (one RSS fetch plus a PI call per
// album). It was the only 200 in app/api without a cache header.
const PUBLISHER_CACHE = { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' };

// An answer assembled without Podcast Index is never cached. It is a real answer
// — the children are read from their own RSS, which is the authoritative
// document — but it is missing the feed ids and guids only PI can supply, and
// caching it would serve that thinner record to everyone for five minutes after
// PI came back. Same rule /api/playlist applies when `couldNotAsk` is non-zero.
const NO_STORE = { 'Cache-Control': 'no-store' };

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
  if (!feedUrl) return NextResponse.json({ feeds: [], listed: 0 });
  if (feedUrl.length > 2048) return NextResponse.json({ error: 'invalid feedUrl' }, { status: 400 });
  return withErrorHandling(async () => {
    const listedUrls = await getPublisherAlbumUrls(feedUrl);
    // **Could not READ it — never cache that, and never call it empty.**
    // `upstream: 'feed'` is load-bearing: `loadCollection` trips the Podcast
    // Index breaker on any 5xx, and PI is not what failed here. Tripping it
    // over a blip at the publisher's own host would disable metadata resolution
    // for the whole tab, which is the 227-favorites failure arriving through a
    // new door.
    if (listedUrls === null) {
      return NextResponse.json(
        { error: 'could not read the publisher feed', upstream: 'feed' },
        { status: 502, headers: NO_STORE },
      );
    }
    const albumUrls = listedUrls.slice(0, MAX_PUBLISHER_ALBUMS);
    // Read, and it genuinely lists nothing. Cacheable, because that is an answer.
    if (!albumUrls.length) {
      return NextResponse.json({ feeds: [], listed: 0 }, { headers: PUBLISHER_CACHE });
    }

    // Probe-first-then-batch, the repo's convention for PI fan-outs: resolve one
    // before firing the rest so a degraded PI costs a single call instead of N.
    // getPodcastByFeedUrl already swallows PI's 400/404 "feed not found" into
    // null, so a throw here is PI itself failing — and the resulting 5xx is what
    // trips the client-side breaker in lib/podcast-meta.
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
    // accelerator. It is `no-store`, and `isPreview` still tells the client
    // which records came back without a PI id.
    let couldNotAskPi = false;
    let fromPi: (Podcast | null)[];
    try {
      const probe = await getPodcastByFeedUrl(albumUrls[0]);
      const rest = await Promise.all(
        albumUrls.slice(1).map((url) => getPodcastByFeedUrl(url).catch(() => null)),
      );
      fromPi = [probe, ...rest];
    } catch (e) {
      if (!(e instanceof PiHttpError) || (e.status !== 429 && e.status !== 408)) throw e;
      couldNotAskPi = true;
      fromPi = albumUrls.map(() => null);
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
    // `listed` is how many children the publisher NAMED, against `feeds.length`
    // for how many we could resolve. Both repairs above can still come up
    // empty — a child PI does not hold and whose RSS also fails to read — and
    // the drop is silent by design, because one dead entry must not cost the
    // reader the other nine.
    //
    // But a caller with only the survivors cannot tell a collection of four
    // from a collection of ten with six missing, and it will print the number
    // it has as a fact. That is the failure this repo keeps paying for:
    // withholding while asserting the opposite. Reported rather than repaired
    // here, because the route genuinely cannot tell WHY a child would not
    // resolve, and only the surface knows whether it is about to make a claim.
    return NextResponse.json(
      { feeds, listed: albumUrls.length, couldNotAskPi },
      { headers: couldNotAskPi ? NO_STORE : PUBLISHER_CACHE },
    );
  }, 'publisher resolution failed');
}
