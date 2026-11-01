import { NextResponse } from 'next/server';
import { withErrorHandling, readCappedRequestJson, requireJsonBody } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { batchPodcasts, MAX_BATCH } from '@/lib/pi-batch';

/**
 * Same 120-char bound as the single route, and the `url:` prefix is the
 * podroll fallback for feeds PI does not index by guid — and the whole of an
 * OPML import, which knows each show only by its feed address.
 */
function isLookupKey(g: string): boolean {
  return g.length > 0 && g.length <= 2048 && (g.startsWith('url:') || g.length <= 120);
}

/** MAX_BATCH `url:` keys at the 2048-char ceiling, with room for the JSON. */
const MAX_REQUEST_BYTES = 256 * 1024;

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
    .filter(isLookupKey)
    .slice(0, MAX_BATCH);
  if (!guids.length) return NextResponse.json({ error: 'no valid guids' }, { status: 400 });

  return withErrorHandling(async () => {
    const podcasts = await batchPodcasts(guids);
    return NextResponse.json(
      { podcasts },
      // NO `max-age`, DELIBERATELY, and the reason is the same one CLAUDE.md
      // records for `/api/episode-by-guid`: the client already holds these for
      // seven days in `bmb:pmeta` / `bmb:epmeta`, so a private window buys
      // nothing. The batch siblings were on the list of routes to "fix" in the
      // audit that added `max-age` to `/api/search`, `/api/publisher`,
      // `/api/remote-item` and `/api/keysend`; they were decided against that
      // rule rather than by matching the header's shape.
      //
      // The real cost on this surface was never the header. `warmPodcastCache` /
      // `warmEpisodeCache` filtered against their module-level memory maps only,
      // and those are empty on every page load — so a returning reader issued
      // six batch requests for records already on their own disk. They consult
      // `storage.podcastMeta` / `storage.episodeMeta` now. That is the fix; a
      // `max-age` here would have hidden it.
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    );
  }, 'batch lookup failed');
}

/**
 * The same lookup with the keys in a JSON body: `{ guids: string[] }`.
 *
 * For the OPML import (`lookupFeedUrls` in lib/podcast-meta.ts), whose keys are
 * all `url:<feed address>`. The GET above cannot carry them, for two reasons
 * that both fail quietly rather than with an error: it SPLITS ON COMMAS, and a
 * feed address may contain one, so the key reaches Podcast Index as two halves
 * of an address; and a hundred long addresses do not reliably fit a URL. Same
 * trade `/api/episode-by-guid/batch` made — a POST loses the CDN cache, which a
 * per-user list would rarely hit anyway.
 *
 * THE SAME LIMITER BUCKET as the GET, on purpose: both spend one Podcast Index
 * call per key, so an import and a hydration from one household share one
 * budget rather than doubling it.
 */
export async function POST(req: Request) {
  const limited = rateLimit(req, 'by-guid-batch', 30);
  if (limited) return limited;
  const notJson = requireJsonBody(req);
  if (notJson) return notJson;

  const read = await readCappedRequestJson(req, MAX_REQUEST_BYTES);
  if (!read.ok) return read.response;
  const rawGuids = (read.body as { guids?: unknown })?.guids;
  if (!Array.isArray(rawGuids)) {
    return NextResponse.json({ error: 'guids must be an array' }, { status: 400 });
  }
  const guids = rawGuids
    .filter((g): g is string => typeof g === 'string')
    .map((g) => g.trim())
    .filter(isLookupKey)
    .slice(0, MAX_BATCH);
  if (!guids.length) return NextResponse.json({ error: 'no valid guids' }, { status: 400 });

  return withErrorHandling(async () => {
    const podcasts = await batchPodcasts(guids);
    // No Cache-Control: a POST with a per-user body gives a shared cache
    // nothing to key on — the same reasoning as the episode batch route.
    return NextResponse.json({ podcasts });
  }, 'batch lookup failed');
}
