import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { assertSafeFetchUrl } from '@/lib/safe-fetch';

// Server-side proxy for Podcasting 2.0 chapters JSON. Many chapter hosts
// (e.g. feeds.fountain.fm) serve the file without an Access-Control-Allow-Origin
// header, so a direct browser fetch is CORS-blocked. Proxying it makes the
// client request same-origin. Returns the upstream JSON verbatim so the client
// parser (lib/chapters.ts) stays the single source of truth.
export async function GET(req: Request) {
  const limited = rateLimit(req, 'chapters', 120);
  if (limited) return limited;
  const url = new URL(req.url).searchParams.get('url')?.trim();
  if (!url) return NextResponse.json({ error: 'missing url' }, { status: 400 });
  // Chapter JSON URLs are long (Fountain nests item/file ids), so allow slack.
  if (url.length > 2000) return NextResponse.json({ error: 'invalid url' }, { status: 400 });
  return withErrorHandling(async () => {
    assertSafeFetchUrl(url);
    const res = await fetch(url, {
      headers: { 'User-Agent': process.env.APP_NAME ?? 'boostmebitch/0.1' },
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `upstream ${res.status}` }, { status: 502 });
    }
    const data = await res.json();
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400' },
    });
  }, 'chapters fetch failed');
}
