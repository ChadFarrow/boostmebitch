import { NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { safeFetch } from '@/lib/safe-fetch';

/**
 * GET /api/audio-probe?url=<enclosure> → `{ status }`, the HTTP status the
 * enclosure's host answers for its FIRST BYTE.
 *
 * WHY. `<Player>` asks this about the file a track ENDING would move to, ~30 s
 * before the end (`components/player/use-next-probe.ts`), so a dead file (404,
 * 410) is passed over before the audio element ever loads it. On an iPhone in
 * the background a dead file's load error ENDS the page's audio: WebKit makes
 * an element's media session inactive on a fatal load error, and a hidden page
 * cannot start audio again — the next track sat at 0:00 under a page that
 * believed it was playing (Chad, 2026-11-13, #555). The browser cannot ask
 * itself: most enclosure hosts send no CORS headers, so a `fetch` from the page
 * is either refused or opaque, and an opaque 410 looks the same as a 200.
 *
 * It answers 200 with the upstream status in the body — the upstream status is
 * DATA here, not this route's outcome. Nothing of the body is read: a host that
 * ignores `Range` would send the whole file, so the stream is cancelled at once.
 *
 * `url` is feed data, so it goes through `safeFetch` (every redirect hop
 * re-validated, private addresses refused), and a refusal never reflects the
 * message — `assertSafeFetchUrl` names the host it rejected, the same reason
 * `/api/art` answers a bare "fetch failed".
 */
export const runtime = 'nodejs';

/** The 2048-char bound `/api/art` carries on a URL parameter. */
const MAX_URL_LEN = 2048;

export async function GET(req: Request) {
  // One probe per track that plays on its own; a listener skipping through a
  // shuffle makes a few a minute.
  const limited = rateLimit(req, 'audio-probe', 120);
  if (limited) return limited;

  const url = new URL(req.url).searchParams.get('url')?.trim() ?? '';
  if (!url || url.length > MAX_URL_LEN || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: 'bad url' }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await safeFetch(url, {
      headers: { range: 'bytes=0-0', accept: 'audio/*,video/*;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return NextResponse.json({ error: 'fetch failed' }, { status: 502 });
  }
  await upstream.body?.cancel().catch(() => {});

  // Short: a file comes back, and a host's outage is not a deletion. The CDN
  // copy is what a second listener in the same shuffle gets.
  return NextResponse.json(
    { status: upstream.status },
    { headers: { 'cache-control': 'public, max-age=60, s-maxage=600' } },
  );
}
