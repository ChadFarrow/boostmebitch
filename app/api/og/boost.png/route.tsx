import { ImageResponse } from 'next/og';
import { NextResponse } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { safeFetch, readCappedBytes, readBytesUpTo } from '@/lib/safe-fetch';
import { firstGifFrame } from '@/lib/gif-first-frame';

/**
 * The picture a boost note shows: the show's artwork beside the sats, the
 * titles and the BMB wordmark, on one wide banner.
 *
 * GET /api/og/boost.png?art=<url>[&art2=<url>&art3=<url>]&title=<show>&ep=<episode>&sats=<n>
 *   → image/png
 *
 * **The URL of this route is written into signed, immutable kind:1 notes**, the
 * same permanence rule `bmbLandingUrl`'s `www` host already carries. So the
 * path, the parameter names and the `.png` suffix are a public contract:
 * renaming any of them silently blanks the picture on every boost note ever
 * published, and there is no edit to make afterwards. Add parameters, never
 * repurpose one.
 *
 * The `.png` is in the PATH rather than left to `Content-Type` because a Nostr
 * client decides whether a bare URL is an image by looking at the extension —
 * it has not fetched the thing yet when it makes that call. A route serving
 * perfect PNG bytes from an extensionless path renders as a link.
 *
 * Why generate an image at all, rather than name the artwork URL: a cover is
 * square, and a square in a note column is a tall block that pushes the sats,
 * the show and the message apart. A 4:1 banner spends the width a feed actually
 * has. It also closes two gaps the raw URL cannot — artwork whose URL carries
 * no image extension (invisible to every client) and a feed with no artwork at
 * all (nothing to show) both still get a branded banner.
 */

// 4:1. Wide enough to fill a note column at a height that doesn't dominate it.
const W = 1200;
const H = 300;

const INK = 'rgb(10, 10, 8)';
const BONE = 'rgb(253, 250, 243)';
const BOLT = 'rgb(250, 229, 0)';
const MUTED = 'rgb(138, 133, 122)';

/** 2 MB of cover art. Real podcast covers are 50–500 KB. */
const MAX_ART_BYTES = 2 * 1024 * 1024;

/**
 * Formats satori can rasterize. **WebP and AVIF are deliberately absent**: the
 * renderer cannot decode them, and handed one it throws — which would turn a
 * modern-CDN cover into a 502 and no picture at all. Dropping the art and
 * drawing the rest of the banner is the better failure.
 */
const RASTERIZABLE = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif']);

/**
 * Cap and clean a caller-supplied line of text.
 *
 * This route draws whatever text it is given onto a BMB-branded image served
 * from boostmebitch.com, which is the same shape of oracle the site-sign route
 * bounds rather than authenticates — nobody is signed in when a Nostr client
 * loads a picture. So: no control characters (they break the layout engine, and
 * they hide text from the reader while leaving it in the URL), and a hard length
 * that fits the banner. A title past it is ellipsised, which the design does
 * anyway.
 */
function line(raw: string | null, max: number): string {
  if (!raw) return '';
  // Mapped by code point rather than matched by a regex: a control character
  // written literally into a character class is invisible in review, and an
  // editor that normalizes the file silently changes what the class matches.
  const clean = Array.from(raw)
    .map((c) => (c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127 ? c : ' '))
    .join('')
    .split(' ')
    .filter(Boolean)
    .join(' ');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * The cover, as a data URI, or null.
 *
 * `safeFetch` rather than `fetch` because the URL comes from a feed — and here
 * it arrives as a query parameter, so it is straightforwardly attacker-chosen.
 * That is also why the bytes never leave this function: the fetched image is
 * drawn into a PNG, never proxied back, so this cannot be used to read an
 * internal response body. Every failure returns null, because a banner missing
 * its cover still reads correctly and a 502 shows nothing at all.
 */
async function coverDataUri(url: string): Promise<string | null> {
  try {
    const res = await safeFetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!RASTERIZABLE.has(type)) return null;

    // A GIF is read as a bounded PREFIX and cut to its first frame, rather than
    // refused for being over the ceiling.
    //
    // An animated cover is not a rare shape here — Homegrown Hits ships 19 MB
    // of episode art, and docs/ui.md records 20–36 MB GIFs per chapter on that
    // same feed. Refusing it fell through to a channel-level URL, which on that
    // show is a DIFFERENT (older) cover, so the banner quietly advertised the
    // wrong artwork. Frame one is at the front of the file: measured at 606 KB
    // of that 19 MB, so the existing ceiling is already generous for it and
    // `readBytesUpTo` cancels the rest of the transfer.
    //
    // Rejecting a GIF outright would be simpler and worse, and raising the
    // ceiling would be simpler and much worse — the point of the ceiling is
    // that a request which has to answer must not decode 19 MB.
    if (type === 'image/gif') {
      const { bytes, truncated } = await readBytesUpTo(res, MAX_ART_BYTES);
      if (!bytes.byteLength) return null;
      const frame = firstGifFrame(bytes);
      // An untruncated GIF we could not cut is used whole: it fits the ceiling
      // by definition, and a parse failure here means our walk did not
      // recognize the file, not that a decoder won't.
      const usable = frame ?? (truncated ? null : bytes);
      if (!usable) return null;
      return `data:image/gif;base64,${Buffer.from(usable).toString('base64')}`;
    }

    const bytes = await readCappedBytes(res, MAX_ART_BYTES);
    if (!bytes.byteLength) return null;
    return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
  } catch {
    return null;
  }
}

/** The wordmark's bolt, as a path — an emoji would need a font we don't ship. */
function Bolt({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z" />
    </svg>
  );
}

export async function GET(req: Request) {
  // A boost note is public, so this is fetched by every reader's client rather
  // than by ours — many IPs, one image each. The allowance is per-IP, so it
  // bounds one caller re-rendering variants, not a note's popularity.
  const limited = rateLimit(req, 'og-boost', 60);
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const title = line(searchParams.get('title'), 44);
  const ep = line(searchParams.get('ep'), 52);
  const satsRaw = searchParams.get('sats') ?? '';
  const sats = /^\d{1,12}$/.test(satsRaw) ? Number(satsRaw).toLocaleString('en-US') : '';
  // `art`, `art2`, `art3` — the caller's preference order, tried until one
  // answers with something drawable.
  //
  // **The first candidate is routinely unusable and the caller cannot tell.**
  // Homegrown Hits proves it twice: its channel `image` is a 404 on a domain
  // that still resolves, and its episode art is a 19 MB animated GIF, over the
  // ceiling above. Only a fetch separates those from a working URL, and the
  // note-builder makes no fetches — so it sends the whole list and this decides.
  //
  // Sequential, under ONE deadline rather than three independent timeouts: this
  // request has to answer, and three dead hosts at 4 s each is a request that
  // outlives the platform's own limit and returns nothing at all.
  const deadline = Date.now() + 6000;
  let art: string | null = null;
  for (const param of ['art', 'art2', 'art3']) {
    const raw = searchParams.get(param);
    // Length-capped before any network call: an over-long URL is not a real
    // artwork address, and the fetch is the expensive half of this route.
    if (!raw || raw.length > 600) continue;
    if (Date.now() >= deadline) break;
    art = await coverDataUri(raw);
    if (art) break;
  }

  try {
    return new ImageResponse(
      (
        <div
          style={{
            width: W,
            height: H,
            display: 'flex',
            background: INK,
            color: BONE,
            fontFamily: 'sans-serif',
          }}
        >
          {art ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={art} alt="" width={H} height={H} style={{ objectFit: 'cover' }} />
          ) : null}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              flex: 1,
              padding: '0 44px',
              // A hairline in bolt rather than a plain border: it reads as part
              // of the brand when the cover beside it is dark, where a grey
              // line would read as a seam.
              borderLeft: art ? '2px solid rgba(250, 229, 0, 0.35)' : 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Bolt size={44} color={BOLT} />
              <span style={{ fontSize: 46, fontWeight: 700, color: BOLT, letterSpacing: -1 }}>
                {sats ? `${sats} SATS` : 'BOOST'}
              </span>
            </div>
            <span style={{ fontSize: 40, fontWeight: 700, marginTop: 14, lineHeight: 1.1 }}>
              {title || 'boostmebitch.com'}
            </span>
            {ep ? <span style={{ fontSize: 27, color: MUTED, marginTop: 10 }}>{ep}</span> : null}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              padding: '0 30px 22px 0',
              fontSize: 20,
              color: MUTED,
              letterSpacing: 2,
            }}
          >
            BOOSTMEBITCH.COM
          </div>
        </div>
      ),
      {
        width: W,
        height: H,
        // The output is a pure function of the query string, so a published
        // note's banner caches hard. Not `immutable`: a show that re-uploads
        // its artwork should get the new cover on the next revalidation rather
        // than never. On the 200 path only, per the API-route convention.
        headers: {
          'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
        },
      },
    );
  } catch {
    // Never an unhandled 500: a boost note carries this URL forever, and a
    // broken image in a stranger's client is the outcome worth avoiding.
    return NextResponse.json({ error: 'banner render failed' }, { status: 502 });
  }
}
