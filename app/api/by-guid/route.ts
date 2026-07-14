import { NextResponse } from 'next/server';
import { getPodcastByGuid, getPodcastByFeedUrl } from '@/lib/pi';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';

export async function GET(req: Request) {
  // High limit: favorites hydration legitimately fans out ~100 parallel
  // requests on a fresh device (see CLAUDE.md "/api/by-guid resilience").
  const limited = rateLimit(req, 'by-guid', 300);
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
