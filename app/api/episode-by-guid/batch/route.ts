import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { batchEpisodes, MAX_BATCH, type EpisodeRef } from '@/lib/pi-batch';

/**
 * Resolve up to MAX_BATCH `(feedGuid, itemGuid)` pairs in ONE request.
 *
 * POST rather than GET because item guids are commonly permalink URLs — real
 * feeds use them — so a hundred pairs do not reliably fit a query string. That
 * costs the CDN cache, which is the right trade here: a favorites list is
 * per-user, so a shared cache entry would rarely be hit anyway.
 *
 * BOTH guids are required for every pair: PI's /episodes/byguid needs
 * `podcastguid` to disambiguate, and an item guid alone is not a lookup key.
 */
export async function POST(req: Request) {
  const limited = rateLimit(req, 'episode-by-guid-batch', 30);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const rawRefs = (body as { refs?: unknown })?.refs;
  if (!Array.isArray(rawRefs)) {
    return NextResponse.json({ error: 'refs must be an array' }, { status: 400 });
  }

  const refs: EpisodeRef[] = rawRefs
    .filter((r): r is EpisodeRef =>
      Boolean(r) && typeof r === 'object' &&
      typeof (r as EpisodeRef).feedGuid === 'string' && (r as EpisodeRef).feedGuid.length > 0 &&
      (r as EpisodeRef).feedGuid.length <= 120 &&
      typeof (r as EpisodeRef).itemGuid === 'string' && (r as EpisodeRef).itemGuid.length > 0 &&
      (r as EpisodeRef).itemGuid.length <= 2048)
    .slice(0, MAX_BATCH);
  if (!refs.length) return NextResponse.json({ error: 'no valid refs' }, { status: 400 });

  return withErrorHandling(async () => {
    const episodes = await batchEpisodes(refs);
    // No Cache-Control: this is a POST with a per-user body, so there is
    // nothing for a shared cache to key on. Cache-Control on 200 responses
    // only, per convention — and here there is no useful one to set.
    return NextResponse.json({ episodes });
  }, 'batch lookup failed');
}
