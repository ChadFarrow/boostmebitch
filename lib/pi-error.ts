/**
 * Podcast Index's HTTP failures, as a class the whole app can test for.
 *
 * **A leaf with no imports, and that is the point.** `lib/api-handler.ts` has to
 * recognise this error to answer a rate limit honestly (see
 * `piCouldNotAskStatus`), and it wraps every route in `app/api` — nine of which
 * never touch Podcast Index. Importing `lib/pi.ts` there to reach the class
 * would pull the RSS parsers, the bounded caches and the brand table into a
 * transcript proxy for one `instanceof`. `lib/pi.ts` re-exports it, so every
 * existing `import { PiHttpError } from '@/lib/pi'` keeps working.
 */
export class PiHttpError extends Error {
  // **Declared and assigned, never `constructor(readonly status: number)`.** A
  // parameter property is the one TypeScript form that emits runtime code, so
  // `node --experimental-strip-types` refuses it outright — and a leaf that
  // cannot be loaded under plain Node cannot be pinned by a check script, which
  // is the entire reason this file has no imports. It read as the tidier
  // spelling and quietly cost the property the file exists to have.
  readonly status: number;

  constructor(status: number, body: string) {
    super(`PI ${status}: ${body}`);
    this.name = 'PiHttpError';
    this.status = status;
  }
}

/**
 * The status a route should answer with when Podcast Index refused to be asked,
 * or null when the failure is a real one.
 *
 * **"We were refused" is not "PI is down", and the difference is a whole tab.**
 * `lib/podcast-meta.ts` sorts our own routes' answers into three buckets: `>=
 * 500` trips the client-side PI breaker and disables metadata resolution for
 * the life of the tab; `COULD_NOT_ASK` (429, 408) returns an UNCACHED null that
 * deliberately does not; and 404 is a real, cacheable miss.
 *
 * Nothing was mapping a Podcast Index 429 into the middle bucket. Every PI
 * wrapper rethrows anything that is not 400/404, `withErrorHandling` turned the
 * throw into a 500, and the client read that as an outage — so one rate limit
 * during a favorites hydration took the whole list to zero, which is the
 * failure docs/feeds.md records as "227 favorites to 0". `/api/publisher` grew
 * its own 429 branch and the comment justifying it claimed podcast-meta already
 * handled this; podcast-meta's own comment says the opposite, because its 429
 * arm is about `lib/rate-limit.ts` — OUR limiter — and had never seen PI's.
 *
 * Answering the status verbatim is what makes the two indistinguishable at the
 * client, which is correct: from a caller's side "our limiter refused" and
 * "PI's limiter refused" are the same fact and want the same retry.
 *
 * 408 rides along for the same reason 408 is in `COULD_NOT_ASK`: a request that
 * timed out before anything answered said nothing about the data.
 */
export function piCouldNotAskStatus(e: unknown): number | null {
  if (!(e instanceof PiHttpError)) return null;
  return e.status === 429 || e.status === 408 ? e.status : null;
}
