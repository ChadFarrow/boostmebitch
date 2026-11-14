import { NextResponse } from 'next/server';
import { findMovedCandidates } from '@/lib/pi';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';

/**
 * GET /api/moved?guid=<feed guid> → `MovedAnswer` (lib/types.ts)
 *
 * Where a favorite whose feed host closed may have gone under a NEW guid. Only
 * `<MovedOffer>` asks, and only for a favorites row still on a closed host after
 * the resolvers tried the same-guid copy — 15 rows on the list this was built
 * against (RSS Blue, 2026-11-14), never one per favorite. So 120 a minute per
 * IP is generous; the edge cache takes the repeats.
 *
 * A day at the edge: whether an artist re-uploaded an album elsewhere changes on
 * the scale of weeks. Errors go through `withErrorHandling`, so a PI rate limit
 * answers 429 (uncached) rather than a 500.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, 'moved', 120);
  if (limited) return limited;
  const guid = new URL(req.url).searchParams.get('guid')?.trim();
  if (!guid) return NextResponse.json({ error: 'missing guid' }, { status: 400 });
  // Podcast guids are UUIDs; the same 120-char bound /api/by-guid applies.
  if (guid.length > 120) return NextResponse.json({ error: 'invalid guid' }, { status: 400 });
  return withErrorHandling(async () => {
    const answer = await findMovedCandidates(guid);
    if (!answer) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(answer, {
      headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=86400' },
    });
  }, 'lookup failed');
}
