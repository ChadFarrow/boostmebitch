import { NextResponse } from 'next/server';
import { NO_STORE, readCappedRequestJson, requireJsonBody, withErrorHandling } from '@/lib/api-handler';
import { BRAND } from '@/lib/brand';
import { readCappedText } from '@/lib/capped-body';
import { parseOpml } from '@/lib/feed-xml';
import { OPML_MAX_BYTES, opmlLinkVerdict } from '@/lib/opml';
import { rateLimit } from '@/lib/rate-limit';
import { safeFetch } from '@/lib/safe-fetch';

/** One address in a small JSON object. `OPML_URL_MAX` is 2000 characters. */
const MAX_REQUEST_BYTES = 4096;

/**
 * Read an OPML file from a link somebody pasted, and answer with its outlines.
 *
 * On the server because most hosts send no `Access-Control-Allow-Origin`, so a
 * browser could only read the few that do. `lib/opml.ts` decides what the
 * outlines mean, on the device, exactly as it does for a file.
 *
 * **POST, not `?url=`, and `no-store`.** A subscription list is personal, and an
 * address with no key in it can still be one only its owner knows. A query string
 * lands in the platform's logs and, on a GET, keys a shared cache.
 *
 * **Only outlines come back, never the body**, so this is not a general proxy:
 * a page, a feed or a JSON file at the far end is a 422 and nothing of it is
 * returned. That is what makes a fourth read behind `safeFetch` a narrow one —
 * see the list of them in docs/security.md.
 *
 * A refused address is a throw from `safeFetch`, and `withErrorHandling` answers
 * it with the fallback, so the guard does not say which internal hosts exist.
 */
export async function POST(req: Request) {
  const limited = rateLimit(req, 'opml', 20);
  if (limited) return limited;
  const notJson = requireJsonBody(req);
  if (notJson) return notJson;

  const read = await readCappedRequestJson(req, MAX_REQUEST_BYTES);
  if (!read.ok) return read.response;
  const raw = (read.body as { url?: unknown })?.url;
  // The browser asks this first and never sends a refused link. Asked again
  // here because the route must not depend on who is calling it.
  const verdict = typeof raw === 'string' ? opmlLinkVerdict(raw) : null;
  if (!verdict || 'refused' in verdict) {
    return NextResponse.json({ error: 'invalid url' }, { status: 400 });
  }

  return withErrorHandling(async () => {
    const res = await safeFetch(verdict.url, {
      headers: { 'User-Agent': process.env.APP_NAME ?? BRAND.userAgent },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `upstream ${res.status}` }, { status: 502, headers: NO_STORE });
    }
    const outlines = parseOpml(await readCappedText(res, OPML_MAX_BYTES));
    if (!outlines) {
      return NextResponse.json({ error: 'not opml' }, { status: 422, headers: NO_STORE });
    }
    return NextResponse.json({ outlines }, { headers: NO_STORE });
  }, 'opml link failed');
}
