import { NextResponse } from 'next/server';
import { parseChaptersJson } from '@/lib/chapters-json';
import { proxyFeedDocument } from '@/lib/feed-document-proxy';

// Server-side proxy for Podcasting 2.0 chapters JSON. Many chapter hosts
// (e.g. feeds.fountain.fm) serve the file without an Access-Control-Allow-Origin
// header, so a direct browser fetch is CORS-blocked. Proxying it makes the
// client request same-origin. The fetch half is shared with /api/transcript in
// lib/feed-document-proxy.ts; what is done with the body is below.
export async function GET(req: Request) {
  return proxyFeedDocument(req, 'chapters', 'chapters fetch failed', (text) => {
    // Read TEXT and parse here rather than `readCappedJson`, because a strict
    // parse is not the last word on a chapters file. A real feed (V4V Music
    // Spotlight 005) serves 25 valid chapters with an orphan `0` before every
    // `"title"` key, which `JSON.parse` rejects outright — so this route
    // answered 500 and the app rendered "no chapters", which reads exactly like
    // an episode that published none. `parseChaptersJson` tries strict first
    // and only then a narrow, string-aware repair; a well-formed document never
    // reaches it. See `lib/chapters-json.ts`. A document neither parse accepts
    // throws, and the shared handler answers 500 with the fallback message.
    const data = parseChaptersJson(text);
    return NextResponse.json(data, {
      // `max-age` as well as `s-maxage`. A chapters document is keyed by the
      // URL the feed names and changes about as often as the episode does, but
      // with no private cache the browser re-fetched it every time the episode
      // was opened — and a music show's chapters JSON carries a row and an
      // image URL per track. The CDN has been allowed to answer with an
      // hour-old copy since this route was written; this lets the reader's own
      // browser do the same.
      headers: { 'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400' },
    });
  });
}
