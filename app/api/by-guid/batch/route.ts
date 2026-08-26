import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { batchPodcasts, MAX_BATCH } from '@/lib/pi-batch';

/**
 * Resolve up to MAX_BATCH podcast:guid identifiers in ONE request.
 *
 * This is the favorites-hydration fix. The single-guid route costs one request
 * per favorited show — 213 on the list this was sized against, plus 232 tracks
 * on the episode route — drained six at a time because that is what a browser
 * allows per host. That burst is also what exhausts the per-IP limiter, and a
 * 429 used to be negative-cached as "PI does not hold this feed" for the life
 * of the tab.
 *
 * The limit here is low BECAUSE each request does so much: 30/min is nine
 * full hydrations of a 445-entry list per minute per IP.
 *
 * Response is `{ podcasts: { [guid]: Podcast | null } }`, and the difference
 * between a null value and an ABSENT key is the contract — see lib/pi-batch.ts.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, 'by-guid-batch', 30);
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const raw = searchParams.get('guids')?.trim() ?? '';
  if (!raw) return NextResponse.json({ error: 'missing guids' }, { status: 400 });

  const guids = raw
    .split(',')
    .map((g) => g.trim())
    // Same 120-char bound as the single route, and the `url:` prefix is the
    // podroll fallback for feeds PI does not index by guid.
    .filter((g) => g.length > 0 && g.length <= 2048 && (g.startsWith('url:') || g.length <= 120))
    .slice(0, MAX_BATCH);
  if (!guids.length) return NextResponse.json({ error: 'no valid guids' }, { status: 400 });

  return withErrorHandling(async () => {
    const podcasts = await batchPodcasts(guids);
    return NextResponse.json(
      { podcasts },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    );
  }, 'batch lookup failed');
}
