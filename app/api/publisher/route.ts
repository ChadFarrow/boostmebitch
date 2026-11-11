import { NextResponse } from 'next/server';
import { withErrorHandling, NO_STORE } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { getPublisherAlbumUrls } from '@/lib/musicl-resolver';
import { resolveFeedUrls } from '@/lib/feed-resolve';
import type { Podcast } from '@/lib/types';

// Publisher feeds are effectively static — new albums appear rarely — and this
// is by far the most expensive route here (one RSS fetch plus a PI call per
// album). It was the only 200 in app/api without a cache header.
// `max-age`, per the rule in `/api/feed`: a private window shorter than the
// shared one permits no staleness the CDN was not already permitted. This one is
// worth having because a publisher's album list is what "back to the publisher"
// re-renders, and the body carries every album's artwork and value block.
// The NO_STORE answer below is untouched: an answer assembled without Podcast
// Index is never cached at all, shared or private.
const PUBLISHER_CACHE = { 'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600' };

// An answer assembled without Podcast Index is never cached. It is a real answer
// — the children are read from their own RSS, which is the authoritative
// document — but it is missing the feed ids and guids only PI can supply, and
// caching it would serve that thinner record to everyone for five minutes after
// PI came back. Same rule /api/playlist applies when `couldNotAsk` is non-zero.
// (`NO_STORE` is the shared spelling in lib/api-handler.ts.)

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

    // Podcast Index first, the feed's own RSS where PI holds nothing usable, a
    // 429/408 answered from RSS alone — the whole resolution, and the reasoning
    // behind each branch, is `resolveFeedUrls` (lib/feed-resolve.ts). It is
    // shared with the curated-playlist search lane, which resolves this same
    // publisher's children. The probe there stays UNCAUGHT for any other PI
    // failure, so "PI is down" is still a 5xx here and never a page of
    // RSS-derived children pretending PI agreed.
    const { feeds: resolved, couldNotAskPi } = await resolveFeedUrls(albumUrls);
    const feeds = resolved.filter((f): f is Podcast => f !== null);
    // `listed` is how many children the publisher NAMED, against `feeds.length`
    // for how many we could resolve. Both repairs in `resolveFeedUrls` can still come up
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
    // **Resolving NONE of them is a failure, not an empty collection.** A 200
    // with `feeds: []` is indistinguishable from a publisher that lists
    // nothing, and `<HomePage>` renders exactly that: "this publisher feed
    // lists nothing", under a comment asserting the emptiness is genuine.
    // Before the 429 branch above existed the probe threw, the route 500'd, and
    // the reader got "couldn't load these" and a RETRY — so answering 200 here
    // would be a regression introduced by the repair. The reader can retry a
    // 502; nobody retries a sentence stating the collection is empty.
    //
    // Keyed on resolving zero of a non-empty list rather than on
    // `couldNotAskPi`, because the other route to the same screen is PI
    // answering normally while every child's RSS read fails.
    if (!feeds.length) {
      return NextResponse.json(
        { error: 'could not resolve any of this publisher\'s feeds' },
        { status: 502, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { feeds, listed: albumUrls.length, couldNotAskPi },
      // A SHORT collection is not cacheable either, for the same reason the
      // unasked one is not: `feeds.length < listed` means children dropped out,
      // and freezing the survivors into a shared cache for five minutes (and
      // fifteen with stale-while-revalidate) serves that shortfall to everyone
      // long after the transient host failure that caused it. /api/playlist
      // applies the same rule with `couldNotAsk > 0`.
      { headers: couldNotAskPi || feeds.length < albumUrls.length ? NO_STORE : PUBLISHER_CACHE },
    );
  }, 'publisher resolution failed');
}
