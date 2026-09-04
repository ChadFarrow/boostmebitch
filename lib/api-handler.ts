import { NextResponse } from 'next/server';
import { getErrorMessage } from './util';
import { piCouldNotAskStatus } from './pi-error';
import { readCappedText } from './safe-fetch';

/**
 * Read a request body as text, or `null` when it is larger than `maxBytes`.
 *
 * **This app caps every body it reads OUTBOUND and capped nothing inbound.**
 * `await req.json()` and `await req.text()` buffer the whole thing first and
 * measure after — the behaviour `readCappedText` exists to prevent, pointed the
 * other way. `/api/lightning/boostbox` made the mistake most visibly: it read
 * the body in full and *then* refused it over 10 KB, twelve lines above its own
 * correct note that measuring a string you have already allocated is not a cap.
 *
 * The App Router applies no limit of its own — `bodyParser.sizeLimit` is a
 * Pages-API setting and does nothing here. On Vercel the platform refuses a
 * body over 4.5 MB, so the practical ceiling there is 4.5 MB per request; under
 * a self-hosted `next start`, which this repo supports, there was none at all.
 * `/api/nostr/site-sign` is the sharpest case: unauthenticated, 30 per minute
 * per IP.
 *
 * **Returns `null` rather than throwing**, so a route answers with its own
 * literal 400 — the deliberate-message path `withErrorHandling` deliberately
 * never sees. A stream that errors mid-read is also `null`: either way the
 * honest answer to the caller is that the body was not usable, and neither
 * needs to reach the unhandled path.
 */
export async function readCappedRequestText(
  req: Request,
  maxBytes: number,
): Promise<string | null> {
  try {
    return await readCappedText(req, maxBytes);
  } catch {
    return null;
  }
}

/**
 * Wrap a route handler body so unhandled throws return a consistent 500 JSON.
 *
 * **The client gets `fallback`, never the exception's own message.** This is the
 * UNHANDLED path — by definition nobody decided what an anonymous caller should
 * learn from it — and the messages that reach here say more than they look like:
 *
 *   - `PiHttpError` is `` `PI ${status}: ${body}` `` — Podcast Index's raw
 *     response body, reflected verbatim out of our 500.
 *   - `assertSafeFetchUrl` names the host it rejected, and a refused connection
 *     ("fetch failed") reads differently from an open-but-hanging one ("The
 *     operation was aborted due to timeout"). That pair turns the SSRF guard
 *     into an oracle: a caller learns which internal addresses exist by reading
 *     our error strings.
 *
 * The detail still goes to the server log, where it is worth having.
 *
 * This does NOT touch the deliberate messages routes write themselves —
 * `'missing url'`, `` `upstream ${res.status}` `` and friends are 400/502
 * `return`s that never reach this catch. Only an actual throw lands here.
 *
 * **The STATUS is not always 500, and that is a correctness rule rather than a
 * nicety.** A Podcast Index rate limit reaches here as a throw like any other,
 * and answering 500 tells `lib/podcast-meta.ts` that PI is DOWN — which trips
 * the client-side breaker and disables metadata resolution for the life of the
 * tab, cancelling every other lookup in flight. That is the "227 favorites to
 * 0" failure. `piCouldNotAskStatus` returns 429/408 for exactly that case, and
 * podcast-meta's `COULD_NOT_ASK` set already treats those as "nobody asked":
 * an uncached null, no breaker, and the next page load resolves normally.
 *
 * The BODY is unchanged — still `fallback`, never `e.message`. The whole reason
 * this wrapper exists is that `PiHttpError`'s message is Podcast Index's raw
 * response body, and a 429's body is a Cloudflare HTML page.
 */
export async function withErrorHandling(
  fn: () => Promise<NextResponse>,
  fallback: string,
): Promise<NextResponse> {
  try {
    return await fn();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[api] ${fallback}:`, getErrorMessage(e, 'unknown error'));
    return NextResponse.json({ error: fallback }, { status: piCouldNotAskStatus(e) ?? 500 });
  }
}
