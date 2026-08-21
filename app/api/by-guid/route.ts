import { NextResponse } from 'next/server';
import { getPodcastByGuid, getPodcastByFeedUrl } from '@/lib/pi';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';

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
      { podcast },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    );
  }, 'lookup failed');
}
