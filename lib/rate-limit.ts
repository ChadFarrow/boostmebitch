// Sliding-window per-IP rate limiter. In-memory only: state is per server
// instance (per lambda on Vercel) and resets on deploy/cold-start — this is
// best-effort abuse damping for the Podcast Index quota, not a hard
// guarantee. `x-forwarded-for` is platform-set on Vercel; behind a bare
// `next start` with no proxy it's client-controlled, which is acceptable
// for this purpose.
import { NextResponse } from 'next/server';

const WINDOW_MS = 60_000;
const buckets = new Map<string, number[]>();
let lastSweep = 0;

/**
 * Returns a 429 response when `ip` has exceeded `limit` calls to `route`
 * in the past minute, else null (caller proceeds).
 */
export function rateLimit(req: Request, route: string, limit: number): NextResponse | null {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]!.trim() || 'unknown';
  const now = Date.now();
  if (now - lastSweep > WINDOW_MS) {
    // Lazy sweep so dead IPs don't accumulate forever.
    lastSweep = now;
    for (const [k, ts] of buckets) {
      const live = ts.filter((t) => now - t < WINDOW_MS);
      if (live.length) buckets.set(k, live);
      else buckets.delete(k);
    }
  }
  const key = `${route}:${ip}`;
  const ts = (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (ts.length >= limit) {
    buckets.set(key, ts);
    return NextResponse.json(
      { error: 'rate limited — try again in a minute' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }
  ts.push(now);
  buckets.set(key, ts);
  return null;
}
