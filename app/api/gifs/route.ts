import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { readCappedJson } from '@/lib/capped-body';
import { BRAND } from '@/lib/brand';
import { giphyRating, parseGiphyResults } from '@/lib/giphy';
import { looksLikeSecretKey } from '@/lib/nostr/npub-input';

// GIF search for the boost modals, proxied so `GIPHY_API_KEY` never reaches the
// browser. Server-only, like the Podcast Index credentials.
//
// The host is a constant, never caller-supplied, so this is a plain `fetch`
// rather than `safeFetch` — but the body is still third-party and still capped.
// The key rides in GIPHY's query string, so the URL built here is never logged:
// `withErrorHandling` logs the error message alone.

const GIPHY_API = 'https://api.giphy.com/v1/gifs';

/** Rows per answer: a 3-column grid, eight rows deep. */
const LIMIT = 24;

/** A search page is a few dozen KB; anything near this is not a search page. */
const MAX_GIPHY_BYTES = 2 * 1024 * 1024;

const GIF_CACHE = { 'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600' };

export async function GET(req: Request) {
  const limited = rateLimit(req, 'gifs', 60);
  if (limited) return limited;

  const key = process.env.GIPHY_API_KEY;
  if (!key) {
    return NextResponse.json({ error: 'GIF search is not configured' }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') ?? '').trim().slice(0, 50);
  // The client refuses a secret key before it asks; this is the backstop, so a
  // pasted nsec never reaches GIPHY. Tested on the WHOLE parameter, before the
  // 50-character slice could cut a prefix test's input short.
  if (looksLikeSecretKey(searchParams.get('q') ?? '')) {
    return NextResponse.json({ error: 'That looks like a secret key — not searched' }, { status: 400 });
  }

  return withErrorHandling(async () => {
    const params = new URLSearchParams({
      api_key: key,
      limit: String(LIMIT),
      rating: giphyRating(BRAND.id),
      bundle: 'messaging_non_clips',
    });
    // An empty box shows what is trending, so the picker has something to
    // offer before anything is typed.
    if (q) {
      params.set('q', q);
      params.set('lang', 'en');
    }
    const res = await fetch(`${GIPHY_API}/${q ? 'search' : 'trending'}?${params}`, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json({ error: 'GIF search failed' }, { status: 502 });
    }
    const gifs = parseGiphyResults(await readCappedJson(res, MAX_GIPHY_BYTES));
    return NextResponse.json({ gifs }, { headers: GIF_CACHE });
  }, 'GIF search failed');
}
