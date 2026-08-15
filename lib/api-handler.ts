import { NextResponse } from 'next/server';
import { getErrorMessage } from './util';

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
    return NextResponse.json({ error: fallback }, { status: 500 });
  }
}
