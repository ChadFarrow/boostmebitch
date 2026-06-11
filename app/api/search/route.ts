import { NextResponse } from 'next/server';
import { searchPodcasts } from '@/lib/pi';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';

const SEARCH_CACHE = { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' };

export async function GET(req: Request) {
  const limited = rateLimit(req, 'search', 60);
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim();
  if (!q) return NextResponse.json({ feeds: [] }, { headers: SEARCH_CACHE });
  // Cap rather than reject — friendlier for a type-ahead box.
  const query = q.slice(0, 200);
  return withErrorHandling(async () => {
    const feeds = await searchPodcasts(query, 20);
    return NextResponse.json({ feeds }, { headers: SEARCH_CACHE });
  }, 'search failed');
}
