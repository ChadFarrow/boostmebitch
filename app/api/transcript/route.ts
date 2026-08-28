import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { safeFetch, readCappedText } from '@/lib/safe-fetch';
import { BRAND } from '@/lib/brand';

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
    const text = await readCappedText(res);
    // Serve as inert text/plain regardless of the upstream Content-Type. The
    // client parser (lib/transcript.ts) branches on the `?type=` hint, not the
    // MIME, so nothing here needs the real type — and reflecting a malicious
    // transcript host's `text/html` would let it execute in *our* origin and
    // read localStorage (NWC spending credential, bunker key). nosniff blocks
    // the browser from re-inferring HTML from the body.
    return new NextResponse(text, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        // Same reasoning as /api/chapters: keyed by the URL the feed names,
        // already held an hour by the CDN, and re-fetched by the browser on
        // every episode open without a private cache. A transcript is the
        // largest of the per-episode documents.
        'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
      },
    });
  }, 'transcript fetch failed');
}
