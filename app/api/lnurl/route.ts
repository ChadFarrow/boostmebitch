import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { safeFetch, readCappedText } from '@/lib/safe-fetch';

// An LNURL-pay response is small, but LUD-06 lets the `metadata` string carry a
// base64 `image/png` identicon, and real providers do. 64 KB (the keysend cap)
// would reject those, so this is roomier — still far below anything that could
// be used to make the lambda read a large body on someone else's behalf.
const MAX_LNURL_BYTES = 256 * 1024;

// A zap callback carries a signed kind:9734 event in the `nostr` query
// parameter, plus a LUD-21 comment. URL-encoded that is comfortably over the
// 2000 the chapters proxy allows.
const MAX_URL_LENGTH = 8000;

/**
 * Server-side proxy for an LNURL-pay endpoint — the `.well-known/lnurlp`
 * document and the `callback` URL it names.
 *
 * **This is a FALLBACK, not the normal path.** LNURL is browser-facing by
 * design, so nearly every provider sends `Access-Control-Allow-Origin: *` and
 * the client pays them directly, which keeps this server out of the money path
 * and keeps the user's boost message off it. `lib/v4v/lnurl-fetch.ts` only
 * comes here when the direct fetch throws.
 *
 * The exception is real and was reported live: `livewire.io` answers
 * `/.well-known/lnurlp/reflex` with a 302 to a host that sets no CORS header,
 * so the browser blocks the read. The leg then failed on every rail — LNURL is
 * the rail every wallet supports, so nothing else could pay it. That is the
 * whole class this exists for: a provider whose endpoint works perfectly for a
 * server and is unreadable from a page.
 *
 * **POST, with the URL in the BODY, on purpose.** A callback URL carries the
 * user's typed boost message in `comment` and, for a zap, their signed event in
 * `nostr`. As a query parameter all of that would land in this origin's request
 * line, in Vercel's access log, and in a `Referer` — the same reasoning that
 * put the Amber signer result in a fragment rather than a query. It also means
 * no caching, which is correct: the callback mints a payable invoice.
 *
 * Returns the upstream STATUS and BODY verbatim rather than judging them. An
 * LNURL service reports failure as a 200 carrying `{status:"ERROR", reason}` at
 * least as often as by a non-2xx, and `zap.ts` shows that reason to the user.
 * Flattening either into a 502 here would replace the provider's explanation
 * with our own guess, so the client parsers stay the single source of truth —
 * the same rule `/api/keysend` and `/api/chapters` follow.
 */
export async function POST(req: Request) {
  // A boost pays its legs sequentially and makes at most two calls per LNURL
  // leg, so a boost-all over a CORS-less provider is the demanding case. Set
  // against that rather than against a single boost — a 429 in the middle of a
  // payment run is indistinguishable, from the client, from the provider being
  // down. Amplification is 1:1 (one inbound request, one outbound fetch), so a
  // roomy limit here costs no more than the traffic it admits.
  const limited = rateLimit(req, 'lnurl', 240);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const url = typeof (body as { url?: unknown })?.url === 'string'
    ? (body as { url: string }).url.trim()
    : '';
  if (!url) return NextResponse.json({ error: 'missing url' }, { status: 400 });
  if (url.length > MAX_URL_LENGTH) {
    return NextResponse.json({ error: 'invalid url' }, { status: 400 });
  }
  // https only. `assertSafeFetchUrl` admits http as well, which is right for a
  // feed's artwork and wrong here: this request carries a boost message and
  // returns a payable invoice, and no LNURL provider a browser can reach is
  // served over plaintext. Checked before safeFetch so the refusal is ours and
  // names nothing about the target.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json({ error: 'invalid url' }, { status: 400 });
  }
  if (parsed.protocol !== 'https:') {
    return NextResponse.json({ error: 'invalid url' }, { status: 400 });
  }

  return withErrorHandling(async () => {
    // safeFetch, never a bare fetch: the callback URL is chosen by whatever the
    // `.well-known/lnurlp` document said, which is third-party data, and it
    // re-validates every redirect hop. A `safeFetch` refusal names the host it
    // rejected, so it must reach withErrorHandling's generic fallback rather
    // than be caught and reflected here — that is what keeps this from being an
    // SSRF oracle.
    const res = await safeFetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': process.env.APP_NAME ?? 'boostmebitch/0.1',
      },
      cache: 'no-store',
      // Longer than the keysend probe's 3.5 s: this one is not an optional
      // upgrade with a working fallback, it IS the payment, and minting an
      // invoice is slower than serving a static document.
      signal: AbortSignal.timeout(10000),
    });
    // Capped as well as read: the URL is third-party, and the timeout above
    // bounds how LONG this runs, not how many bytes it returns.
    const text = await readCappedText(res, MAX_LNURL_BYTES);
    return NextResponse.json(
      { status: res.status, text },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }, 'lnurl fetch failed');
}
