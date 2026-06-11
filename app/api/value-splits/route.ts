import { NextResponse } from 'next/server';
import { getEpisodes, resolveValueTimeSplits } from '@/lib/pi';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';

export async function GET(req: Request) {
  const limited = rateLimit(req, 'value-splits', 30);
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const feedId = Number(searchParams.get('feedId'));
  // Episode ids can be negative (RSS-derived live items use -fnvHash), so
  // only zero/NaN/fractional are invalid.
  const episodeId = Number(searchParams.get('episodeId'));
  if (!Number.isInteger(feedId) || feedId <= 0 || !Number.isInteger(episodeId) || episodeId === 0) {
    return NextResponse.json({ error: 'missing or invalid feedId / episodeId' }, { status: 400 });
  }
  return withErrorHandling(async () => {
    const episodes = await getEpisodes(feedId, 50);
    const episode = episodes.find((e) => e.id === episodeId);
    if (!episode) return NextResponse.json({ error: 'episode not found' }, { status: 404 });
    const raw = episode.valueTimeSplits ?? [];
    if (!raw.length) return NextResponse.json({ splits: [] });
    const splits = await resolveValueTimeSplits(raw);
    return NextResponse.json(
      { splits },
      // Splits are effectively immutable per episode — let the CDN keep them.
      { headers: { 'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400' } },
    );
  }, 'value-splits fetch failed');
}
