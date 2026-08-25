import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { askIndex, indexConfigured } from '@/lib/nostr-index-server';

// Proxy for the read-only nostr-index service.
//
// It exists for two reasons and both are load-bearing. The shared key stays
// server-side, so the browser never holds a credential for the index. And the
// response gets a `Cache-Control` with `s-maxage`, so Vercel's CDN — not a $5
// Railway box — serves the global feed, which is byte-identical for every
// visitor.
//
// The `path` parameter is matched against a FIXED ALLOWLIST of shapes, never
// forwarded. A pass-through would let anyone reachable here address any route
// on the internal service, and a future write endpoint there would be exposed
// the day it shipped.

type Allowed = { pattern: RegExp; sMaxAge: number };

const ALLOWED: Allowed[] = [
  // Identical for every visitor, so this is where the CDN pays.
  { pattern: /^\/feed\/global$/, sMaxAge: 30 },
  { pattern: /^\/feed\/podcast\/[^/]{1,256}$/, sMaxAge: 60 },
  { pattern: /^\/feed\/episode\/[^/]{1,256}$/, sMaxAge: 60 },
  // Per-visitor pages: still shared (a boost explorer is public), but a shorter
  // window so a fresh boost shows up promptly.
  { pattern: /^\/feed\/by-author\/[0-9a-f]{64}$/, sMaxAge: 15 },
  { pattern: /^\/feed\/mentioning\/[0-9a-f]{64}$/, sMaxAge: 15 },
  { pattern: /^\/zaps\/received\/[0-9a-f]{64}$/, sMaxAge: 15 },
  { pattern: /^\/profiles$/, sMaxAge: 300 },
  // Reposts answer "has THIS viewer already reposted these notes", so the
  // answer is per-viewer and must not be shared by the CDN.
  { pattern: /^\/reposts$/, sMaxAge: 0 },
];

// Only these may be forwarded, and each is bounded. `ids` and `pubkeys` are
// comma-separated hex lists that the service caps again on its own side.
const ALLOWED_PARAMS = new Set(['limit', 'until', 'ids', 'pubkeys', 'pubkey']);

export async function GET(req: Request) {
  const limited = rateLimit(req, 'nostr-index', 300);
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const path = searchParams.get('path')?.trim() ?? '';
  const match = ALLOWED.find((a) => a.pattern.test(path));
  if (!match) return NextResponse.json({ error: 'unknown index path' }, { status: 400 });

  // Absent config is not an error: it is the feature being off. The client
  // treats 503 the same way it treats a timeout — run the relay path.
  if (!indexConfigured()) {
    return NextResponse.json({ error: 'index not configured' }, { status: 503 });
  }

  return withErrorHandling(async () => {
    const forwarded = new URLSearchParams();
    for (const [k, v] of searchParams) {
      if (k !== 'path' && ALLOWED_PARAMS.has(k) && v.length <= 8192) forwarded.set(k, v);
    }
    const qs = forwarded.toString();
    const data = await askIndex<unknown>(`${path}${qs ? `?${qs}` : ''}`);
    // askIndex returns null for "could not ask" — never for "the index says
    // no". 503 keeps that distinction, so the client falls back rather than
    // rendering an empty feed as fact.
    if (data === null) return NextResponse.json({ error: 'index unavailable' }, { status: 503 });
    return NextResponse.json(data, {
      headers: match.sMaxAge
        ? { 'Cache-Control': `public, s-maxage=${match.sMaxAge}, stale-while-revalidate=300` }
        : { 'Cache-Control': 'no-store' },
    });
  }, 'index request failed');
}
