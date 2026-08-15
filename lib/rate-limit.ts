// Sliding-window per-IP rate limiter. In-memory only: state is per server
// instance (per lambda on Vercel) and resets on deploy/cold-start — this is
// best-effort abuse damping for the Podcast Index quota, not a hard
// guarantee. `x-forwarded-for` is platform-set on Vercel; behind a bare
// `next start` with no proxy it's client-controlled, which is acceptable
// for this purpose.
import { NextResponse } from 'next/server';

const WINDOW_MS = 60_000;
// The sweep below runs at most once a minute, so between sweeps this grows by
// one entry per distinct `route:ip` — and `ip` comes from a request header. A
// hard ceiling means a caller rotating that header inflates memory for one
// window instead of until the instance dies. Well above the number of real
// clients a single lambda sees in a minute.
const MAX_BUCKETS = 20_000;
// Bucket keys are built from a header, so the header's LENGTH is part of the
// key's cost. Longer than any real IPv6 form (45 chars), short enough that
// 20 000 of them is bounded memory rather than a lever.
const MAX_IP_LEN = 64;
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
  if (real) return clamp(real);
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return clamp(parts[parts.length - 1]!);
  }
  return 'unknown';
}

// Both sources are request headers, so whatever comes back becomes part of a
// Map key this process retains for a minute. Truncating bounds that; it does not
// make a spoofed value trustworthy, and isn't meant to.
function clamp(ip: string): string {
  return ip.length > MAX_IP_LEN ? ip.slice(0, MAX_IP_LEN) : ip;
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
  // At the ceiling, evict oldest-first to make room rather than refusing to
  // track. A Map iterates in insertion order, so this drops the least recently
  // *created* bucket. Losing a bucket only forgives a client its earlier
  // requests — the failure mode is a limiter that's briefly too lenient under
  // key-rotation flooding, which is strictly better than one that stops
  // bounding memory.
  if (!buckets.has(key) && buckets.size >= MAX_BUCKETS) {
    const oldest = buckets.keys().next();
    if (!oldest.done) buckets.delete(oldest.value);
  }
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
