import { NextResponse } from 'next/server';
import { getRecentEpisodesForFeeds } from '@/lib/pi';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';

// Recent-episode window for the Inbox "new episodes" check (30 days). Bounds
// the PI payload so a big favorites set doesn't pull thousands of episodes.
const NEW_WINDOW_SEC = 30 * 24 * 60 * 60;
// Hard cap on how many feed ids we'll query in one request (abuse guard).
const MAX_IDS = 200;

export async function GET(req: Request) {
  const limited = rateLimit(req, 'new-episodes', 30);
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const ids = (searchParams.get('ids') ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, MAX_IDS);
  if (!ids.length) {
    return NextResponse.json({ error: 'missing or invalid ids' }, { status: 400 });
  }
  return withErrorHandling(async () => {
    const since = Math.floor(Date.now() / 1000) - NEW_WINDOW_SEC;
    const episodes = await getRecentEpisodesForFeeds(ids, since);
    // Flat list; each item carries feedId, so the client groups by favorite.
    return NextResponse.json(
      { episodes },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    );
  }, 'new-episodes fetch failed');
}
