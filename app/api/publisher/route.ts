import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { getPublisherAlbumUrls } from '@/lib/musicl-resolver';
import { getPodcastByFeedUrl } from '@/lib/pi';

export async function GET(req: Request) {
  const limited = rateLimit(req, 'publisher', 30);
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const feedUrl = searchParams.get('feedUrl')?.trim();
  if (!feedUrl) return NextResponse.json({ feeds: [] });
  return withErrorHandling(async () => {
    const albumUrls = await getPublisherAlbumUrls(feedUrl);
    const results = await Promise.all(
      albumUrls.map((url) => getPodcastByFeedUrl(url).catch(() => null)),
    );
    const feeds = results.filter((f): f is NonNullable<typeof f> => f !== null);
    return NextResponse.json({ feeds });
  }, 'publisher resolution failed');
}
