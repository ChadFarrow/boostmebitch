import { NextResponse } from 'next/server';
import { getFeedFromRss, getPodcastByGuid, getPodcastByFeedUrl } from '@/lib/pi';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { mergeRssOverPi, piRecordIsBlank } from '@/lib/util';
import type { Podcast } from '@/lib/types';

/**
 * Podcast Index's record, repaired from the feed's own RSS when PI holds a feed
 * it registered but never parsed.
 *
 * **On this route a blank record is not merely an ugly row — it is a WRONG
 * MEDIUM, and this is the route every `?podcast=<guid>` deep link resolves
 * through.** A record PI could not parse carries the default `medium: "podcast"`
 * beside its empty title, and `<HomePage>` reads exactly that field to decide
 * whether the show it just resolved is a playlist. So a `musicL` playlist opened
 * as an ordinary show: `<EpisodeList>` asked `/api/feed?id=`, which ran the full
 * PI episode fetch, the RSS enrichment pass and both live-item lookups for a
 * feed that publishes no `<item>` at all, answered with zero episodes, and only
 * then did the client fall back to `/api/playlist` for the same feed.
 *
 * Measured on ChadF's Greatest Hits (PI feed 7683902, the `piRecordIsBlank`
 * fixture): three server round trips in series before the first track, the
 * middle one discarded in full. Repairing the medium here removes that middle
 * request entirely — the client knows it holds a playlist as soon as this route
 * answers.
 *
 * `/api/search` and `/api/publisher` already do this, for the visible half of
 * the same fault. It is the same two helpers in the same order, and PI still
 * keeps what only it can supply: the numeric id and the guid.
 *
 * **The RSS read is gated on the record being blank, and that gate is load-
 * bearing here rather than merely tidy.** Favorites hydration issues one request
 * to this route per favorited show — 213 on the list the limiter above is sized
 * against — and an unconditional fetch would put a third-party feed download
 * behind every one of them. A failure leaves PI's record exactly as it was: this
 * is a repair, never a precondition.
 */
async function repairIfBlank(pi: Podcast): Promise<Podcast> {
  if (!piRecordIsBlank(pi) || !pi.url) return pi;
  const parsed = await getFeedFromRss(pi.url).catch(() => null);
  return parsed?.podcast ? mergeRssOverPi(pi, parsed.podcast) : pi;
}

export async function GET(req: Request) {
  // SIZED AGAINST A REAL FAVORITES LIST, NOT A GUESS. One request per feed
  // guid, so a cold hydration issues one per favorited show — the list this was
  // measured against carries 213, and 300 was chosen when the comment here said
  // "~100". A phone and a desktop share one household IP, a reload repeats the
  // burst, and 213 x 2 is already over. Going over does not degrade gracefully:
  // it 429s, and until recently lib/podcast-meta.ts negative-cached a 429 as
  // "PI does not hold this feed" for the life of the tab.
  //
  // 900 is three full hydrations a minute per IP. It still bounds amplification
  // against our PI quota, which is what this limiter is for. The real fix is a
  // batch endpoint so one list costs one request; until then the limit has to
  // fit the list.
  const limited = rateLimit(req, 'by-guid', 900);
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const guid = searchParams.get('guid')?.trim();
  // `url` is the podroll fallback for feeds PI doesn't index by guid. Not an
  // SSRF surface: it's forwarded to PI's /podcasts/byfeedurl as a query param,
  // we never fetch it ourselves.
  const feedUrl = searchParams.get('url')?.trim();
  if (!guid && !feedUrl) {
    return NextResponse.json({ error: 'missing guid or url' }, { status: 400 });
  }
  // Podcast GUIDs are UUIDs (36 chars); 120 leaves slack for odd-but-real
  // values without letting kilobyte strings reach PI. Feed URLs get a roomier
  // cap — real ones run long, but not unbounded.
  if (guid && guid.length > 120) return NextResponse.json({ error: 'invalid guid' }, { status: 400 });
  if (feedUrl && feedUrl.length > 2048) return NextResponse.json({ error: 'invalid url' }, { status: 400 });
  return withErrorHandling(async () => {
    const podcast = guid ? await getPodcastByGuid(guid) : await getPodcastByFeedUrl(feedUrl!);
    if (!podcast) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(
      { podcast: await repairIfBlank(podcast) },
      {
        // `max-age` is the half that was missing, and it is the same argument
        // `/api/feed` documents: with `s-maxage` alone the CDN may hold this
        // record for five minutes while the BROWSER re-asks on every navigation
        // that resolves a guid — which on this route is every show opened from
        // favorites, from a podroll, or from a shared link, several times per
        // session. A private cache SHORTER than the shared one adds no staleness
        // class that was not already permitted.
        headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600' },
      },
    );
  }, 'lookup failed');
}
