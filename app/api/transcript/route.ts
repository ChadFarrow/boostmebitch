import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { assertSafeFetchUrl } from '@/lib/safe-fetch';

// Server-side proxy for Podcasting 2.0 <podcast:transcript> files. Same reason
// as /api/chapters: many transcript hosts serve without an
// Access-Control-Allow-Origin header, so a direct browser fetch is CORS-blocked.
// Unlike chapters (always JSON), transcripts are text (SRT/VTT) OR JSON, so we
// return the upstream body verbatim as text and pass its Content-Type through —
// the client parser (lib/transcript.ts) branches on the format. The optional
// `type` param carries the feed-declared MIME so the client can parse even when
// the host serves a generic content-type.
export async function GET(req: Request) {
  const limited = rateLimit(req, 'transcript', 120);
  if (limited) return limited;
  const url = new URL(req.url).searchParams.get('url')?.trim();
  if (!url) return NextResponse.json({ error: 'missing url' }, { status: 400 });
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
    const text = await res.text();
    const upstreamType = res.headers.get('content-type');
    return new NextResponse(text, {
      headers: {
        'Content-Type': upstreamType ?? 'text/plain; charset=utf-8',
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      },
    });
  }, 'transcript fetch failed');
}
