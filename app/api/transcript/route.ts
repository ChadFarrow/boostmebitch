import { NextResponse } from 'next/server';
import { proxyFeedDocument } from '@/lib/feed-document-proxy';

// Server-side proxy for Podcasting 2.0 <podcast:transcript> files. Same reason
// as /api/chapters: many transcript hosts serve without an
// Access-Control-Allow-Origin header, so a direct browser fetch is CORS-blocked.
// The fetch half is shared with it in lib/feed-document-proxy.ts. Transcripts
// are text (SRT/VTT) or JSON, and the body goes back VERBATIM — but always as
// inert text/plain, never with the upstream's Content-Type: see below. The
// client parser (lib/transcript.ts) branches on the `?type=` hint the client
// adds from the feed-declared MIME, so it never needs the real one.
export async function GET(req: Request) {
  return proxyFeedDocument(req, 'transcript', 'transcript fetch failed', (text) =>
    // Serve as inert text/plain regardless of the upstream Content-Type. The
    // client parser (lib/transcript.ts) branches on the `?type=` hint, not the
    // MIME, so nothing here needs the real type — and reflecting a malicious
    // transcript host's `text/html` would let it execute in *our* origin and
    // read localStorage (NWC spending credential, bunker key). nosniff blocks
    // the browser from re-inferring HTML from the body.
    new NextResponse(text, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        // Same reasoning as /api/chapters: keyed by the URL the feed names,
        // already held an hour by the CDN, and re-fetched by the browser on
        // every episode open without a private cache. A transcript is the
        // largest of the per-episode documents.
        'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
      },
    }),
  );
}
