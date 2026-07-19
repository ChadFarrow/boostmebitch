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
 * Best-effort client IP for bucketing. `x-forwarded-for` is a client-supplied
 * header that a trusted proxy *appends* the real peer to, so the **leftmost**
 * entry is attacker-controlled — rotating it lands every request in a fresh
 * bucket and defeats the limiter. Prefer Vercel's platform-set `x-real-ip`
 * (the actual TCP peer, not influenceable by a spoofed XFF); fall back to the
 * **rightmost** XFF hop (the one the last trusted proxy added).
 */
function clientIp(req: Request): string {
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1]!;
  }
  return 'unknown';
}

/**
 * Returns a 429 response when `ip` has exceeded `limit` calls to `route`
 * in the past minute, else null (caller proceeds).
 */
export function rateLimit(req: Request, route: string, limit: number): NextResponse | null {
  const ip = clientIp(req);
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
