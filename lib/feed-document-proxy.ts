import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { safeFetch } from '@/lib/safe-fetch';
import { readCappedText } from '@/lib/capped-body';
import { BRAND } from '@/lib/brand';

/**
 * The fetch half of `/api/chapters` and `/api/transcript`, which were one
 * function written twice. Server-only.
 *
 * Both proxy a document a FEED names, for the same reason: many hosts serve
 * chapters and transcripts with no `Access-Control-Allow-Origin`, so a direct
 * browser fetch is CORS-blocked. Everything up to the body is identical and
 * lives here — rate limit, the `url` parameter, `safeFetch` (every redirect hop
 * re-validated, every hostname resolved), the timeout, the 502 on an upstream
 * failure and the capped read. What each route does with the TEXT is not the
 * same and stays with the route: chapters parse it, transcripts serve it as
 * inert `text/plain`, and each carries its own reasoning beside `respond`.
 *
 * Not in `lib/safe-fetch.ts`: `check:ssrf` loads that module under plain Node,
 * and this one imports `next/server`.
 */
export async function proxyFeedDocument(
  req: Request,
  route: 'chapters' | 'transcript',
  fallback: string,
  respond: (text: string) => NextResponse,
): Promise<NextResponse> {
  const limited = rateLimit(req, route, 120);
  if (limited) return limited;
  const url = new URL(req.url).searchParams.get('url')?.trim();
  if (!url) return NextResponse.json({ error: 'missing url' }, { status: 400 });
  // Chapter JSON URLs are long (Fountain nests item/file ids), so allow slack.
  if (url.length > 2000) return NextResponse.json({ error: 'invalid url' }, { status: 400 });
  return withErrorHandling(async () => {
    const res = await safeFetch(url, {
      headers: { 'User-Agent': process.env.APP_NAME ?? BRAND.userAgent },
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `upstream ${res.status}` }, { status: 502 });
    }
    // Capped: the URL is feed-supplied, and the 8 s timeout above bounds how
    // long this runs, not how many bytes it returns.
    return respond(await readCappedText(res));
  }, fallback);
}
