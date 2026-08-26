import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { rateLimit } from '@/lib/rate-limit';
import { safeFetch, readCappedBytes } from '@/lib/safe-fetch';
import { artTypeVerdict, artWidth } from '@/lib/util';

/**
 * Shrink a feed-supplied cover to the size the app actually draws it at.
 *
 * GET /api/art?url=<encoded>&w=160|320|640|1024  →  image/webp
 *
 * Podcast artwork is authored as a poster and rendered here as a tile.
 * Measured across 53 live feeds on 2026-08-25: 27.68 MB in total, 535 KB
 * average, 230 KB median, largest 8,090 KB — for squares the app paints at
 * 64 to 160 pixels. On a 213-show favorites list that is over 100 MB pulled
 * from nineteen unrelated hosts, none of which we can ask to do anything
 * differently. A 320px WebP of the same cover is 10–15 KB.
 *
 * **This is an accelerator and must never become a dependency.** Every failure
 * here — a refused width, an undecodable format, a host that is down, this
 * route not being deployed at all — is answered with a non-200 and nothing
 * else. `<PodcastCover>` lists the ORIGINAL third-party URLs behind the
 * proxied ones, so its `onError` ladder falls through to exactly the behaviour
 * the app had before this route existed. Do not add a redirect-to-origin
 * fallback here: a 302 is a 200 to the browser's `onError`, which would move
 * the failure from "one slow cover" to "the CDN caches a redirect", and it
 * would hide from us that the proxy is failing at all.
 *
 * `url` is feed data, so it goes through `safeFetch` — which re-validates
 * every redirect hop and resolves the hostname, because an IP-literal check
 * alone is beaten by a public DNS record needing no attacker infrastructure
 * (`http://127.0.0.1.nip.io/`). That is the repo-wide rule for any server-side
 * fetch of a feed URL and it is the reason this route can exist at all.
 */

// sharp is a native module. It cannot run on the edge runtime, and the failure
// if this line is removed is a build-time module resolution error rather than
// anything subtle — but it is removed by "tidying" often enough to say so.
export const runtime = 'nodejs';

/**
 * 12 MB, deliberately larger than `/api/og/boost.png`'s 2 MB cap.
 *
 * That route draws a thumbnail into a banner and can afford to skip a cover it
 * considers oversized. This one exists BECAUSE covers are oversized: the
 * largest measured on the live feed is 8,090 KB, and a 2 MB cap would refuse
 * precisely the images with the most to gain, leaving them to fall back to the
 * raw URL — the proxy would look installed and do nothing for the worst cases.
 */
const MAX_ART_BYTES = 12 * 1024 * 1024;

/** Same 2048-char bound every other proxy parameter in this app carries. */
const MAX_URL_LEN = 2048;

export async function GET(req: Request) {
  // Generous, because the CDN absorbs the repeat traffic: a favorites page
  // issues one request per VISIBLE cover and every one of them is a cache hit
  // after the first viewer anywhere in the world.
  const limited = rateLimit(req, 'art', 300);
  if (limited) return limited;

  const { searchParams } = new URL(req.url);

  const width = artWidth(searchParams.get('w'));
  // Pinned by `npm run check:art`. An arbitrary integer here is an unbounded
  // family of cache keys, each miss costing a full decode-and-resize.
  if (width === null) return NextResponse.json({ error: 'bad width' }, { status: 400 });

  const url = searchParams.get('url')?.trim() ?? '';
  if (!url || url.length > MAX_URL_LEN) {
    return NextResponse.json({ error: 'bad url' }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await safeFetch(url, {
      headers: { accept: 'image/*' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Never reflect the message. `assertSafeFetchUrl` names the host it
    // rejected, so echoing it turns this route into an SSRF oracle — the same
    // reason lib/api-handler.ts returns a fallback rather than `e.message`.
    return NextResponse.json({ error: 'fetch failed' }, { status: 502 });
  }

  if (!upstream.ok) return NextResponse.json({ error: 'upstream error' }, { status: 502 });

  // Documents are refused; anything image-shaped or unlabelled goes to the
  // decoder, which reads magic bytes and is the only honest judge of whether
  // these are pixels. See artTypeVerdict for why the header is not a boundary.
  if (artTypeVerdict(upstream.headers.get('content-type')) === 'refuse') {
    return NextResponse.json({ error: 'unsupported type' }, { status: 415 });
  }

  let out: Buffer;
  try {
    const bytes = await readCappedBytes(upstream, MAX_ART_BYTES);
    out = await sharp(Buffer.from(bytes), {
      // An animated cover is a real thing on music feeds — 20-36 MB GIFs have
      // been measured on one. Take frame one: this is a static tile, and
      // decoding every frame to throw them away is the expensive way to get
      // the same pixel.
      animated: false,
      // A decompression bomb is a small file that decodes to an enormous
      // raster. sharp refuses those above this ceiling rather than allocating.
      limitInputPixels: 100_000_000,
    })
      .resize(width, width, { fit: 'cover', position: 'centre', withoutEnlargement: true })
      .webp({ quality: 78, effort: 4 })
      .toBuffer();
  } catch {
    return NextResponse.json({ error: 'decode failed' }, { status: 502 });
  }

  // `Cache-Control` on the 200 only, as every route here does. A week, not
  // `immutable`: the cache key is the source URL, and a publisher who replaces
  // their cover keeps the same URL, so a permanent cache would pin the old art
  // forever with no way to clear it short of a query-string change.
  return new NextResponse(new Uint8Array(out), {
    headers: {
      'content-type': 'image/webp',
      'cache-control': 'public, s-maxage=604800, stale-while-revalidate=86400',
    },
  });
}
