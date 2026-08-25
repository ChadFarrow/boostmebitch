import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { safeFetch, readCappedText } from '@/lib/safe-fetch';
import { parseChaptersJson } from '@/lib/chapters-json';

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
    const res = await safeFetch(url, {
      headers: { 'User-Agent': process.env.APP_NAME ?? 'boostmebitch/0.1' },
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `upstream ${res.status}` }, { status: 502 });
    }
    // Capped: the URL is feed-supplied, and the 8 s timeout above bounds how
    // long this runs, not how many bytes it returns.
    //
    // Read TEXT and parse here rather than `readCappedJson`, because a strict
    // parse is not the last word on a chapters file. A real feed (V4V Music
    // Spotlight 005) serves 25 valid chapters with an orphan `0` before every
    // `"title"` key, which `JSON.parse` rejects outright — so this route
    // answered 500 and the app rendered "no chapters", which reads exactly like
    // an episode that published none. `parseChaptersJson` tries strict first
    // and only then a narrow, string-aware repair; a well-formed document never
    // reaches it. See `lib/chapters-json.ts`.
    const data = parseChaptersJson(await readCappedText(res));
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400' },
    });
  }, 'chapters fetch failed');
}
