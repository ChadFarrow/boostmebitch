// Sliding-window rate limiter, TWO buckets per call. In-memory only: state is
// per server instance (per lambda on Vercel) and resets on deploy/cold-start —
// this is best-effort abuse damping for the Podcast Index quota and the
// site-signing oracle, not a hard guarantee.
//
// Bucket one is per `route:ip`. Bucket two is per ROUTE, and it exists because
// the first can be walked around: a route handler never sees the socket's peer
// address, only headers, and `x-forwarded-for` is platform-set on Vercel but
// client-controlled behind a bare `next start` with no proxy — so a caller
// there rotates the header and lands every request in a fresh per-IP bucket.
// That used to be the ONLY control on `/api/nostr/site-sign`, an
// unauthenticated signing oracle. The route bucket does not care who is
// asking: it caps the instance's total at `limit × GLOBAL_MULTIPLIER` per
// minute, so header rotation buys at most that, not unbounded.
//
// The trade-off is stated rather than hidden: when the route bucket is full,
// honest clients on that instance get a 429 too. `lib/podcast-meta.ts` files a
// 429 under `COULD_NOT_ASK` (an uncached null, no breaker trip), so the client
// degrades for a minute instead of poisoning its caches.
import { NextResponse } from 'next/server';

const WINDOW_MS = 60_000;
// The per-route ceiling, as a multiple of one honest client's allowance. 20
// puts `/api/feed` (60/min per IP) at 1,200 a minute per instance — twenty
// feed loads a second from ONE lambda is a scaling event, not a rate-limit
// event — and `/api/nostr/site-sign` (30/min) at 600 signed notes a minute:
// a bounded oracle where there was an unbounded one, still far above real use.
const GLOBAL_MULTIPLIER = 20;
// Keyed by route only, so it holds about as many entries as there are routes.
// Deliberately NOT subject to the oldest-first eviction below: these keys are
// the oldest in any flood, so they would be the first to go.
const routeBuckets = new Map<string, number[]>();
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
  if (real) return clampIp(real);
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return clampIp(parts[parts.length - 1]!);
  }
  return 'unknown';
}

// Both sources are request headers, so whatever comes back becomes part of a
// Map key this process retains for a minute. Truncating bounds that; it does not
// make a spoofed value trustworthy, and isn't meant to.
function clampIp(ip: string): string {
  return ip.length > MAX_IP_LEN ? ip.slice(0, MAX_IP_LEN) : ip;
}

function liveHits(map: Map<string, number[]>, key: string, now: number): number[] {
  return (map.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
}

function sweep(map: Map<string, number[]>, now: number): void {
  for (const [k, ts] of map) {
    const live = ts.filter((t) => now - t < WINDOW_MS);
    if (live.length) map.set(k, live);
    else map.delete(k);
  }
}

/**
 * Returns a 429 response when `ip` has exceeded `limit` calls to `route` in
 * the past minute, OR when the route as a whole has exceeded
 * `limit × GLOBAL_MULTIPLIER` on this instance; else null (caller proceeds).
 */
export function rateLimit(req: Request, route: string, limit: number): NextResponse | null {
  const ip = clientIp(req);
  const now = Date.now();
  if (now - lastSweep > WINDOW_MS) {
    // Lazy sweep so dead IPs don't accumulate forever.
    lastSweep = now;
    sweep(buckets, now);
    sweep(routeBuckets, now);
  }
  const key = `${route}:${ip}`;
  const ipHits = liveHits(buckets, key, now);
  const routeHits = liveHits(routeBuckets, route, now);
  if (ipHits.length >= limit || routeHits.length >= limit * GLOBAL_MULTIPLIER) {
    buckets.set(key, ipHits);
    routeBuckets.set(route, routeHits);
    return NextResponse.json(
      { error: 'rate limited — try again in a minute' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }
  // At the ceiling, evict oldest-first to make room rather than refusing to
  // track. A Map iterates in insertion order, so this drops the least recently
  // *created* bucket. Losing a bucket only forgives a client its earlier
  // requests — the failure mode is a limiter that's briefly too lenient under
  // key-rotation flooding, which is strictly better than one that stops
  // bounding memory. The route bucket above is what bounds the flood itself.
  if (!buckets.has(key) && buckets.size >= MAX_BUCKETS) {
    const oldest = buckets.keys().next();
    if (!oldest.done) buckets.delete(oldest.value);
  }
  ipHits.push(now);
  routeHits.push(now);
  buckets.set(key, ipHits);
  routeBuckets.set(route, routeHits);
  return null;
}
