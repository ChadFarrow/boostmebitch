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

type Allowed = {
  pattern: RegExp;
  sMaxAge: number;
  /**
   * Which query params this path may forward. Defaults to DEFAULT_PARAMS.
   *
   * PER-PATH rather than one flat set, because the set is a widening: every
   * name in it becomes forwardable on every route, and it lands in the CDN
   * cache key. A free-text `q` in a global set would make
   * `/feed/global?q=<random>` a cache-buster that reaches the service on every
   * distinct value — on the one route where the edge cache actually pays.
   */
  params?: Set<string>;
};

const ALLOWED: Allowed[] = [
  // Identical for every visitor, so this is where the CDN pays.
  { pattern: /^\/feed\/global$/, sMaxAge: 30 },
  // Live activities are identical for every visitor too, but they are a claim
  // about NOW, so the edge window is short. The service refuses this route
  // outright when its own index is more than five minutes behind, and the
  // client falls back to relays — so a cached 503 would extend that refusal
  // past its usefulness, which is why this is the shortest window here.
  { pattern: /^\/feed\/live$/, sMaxAge: 15 },
  // `[^/?#]`, NOT `[^/]`. These two are the only patterns here with a free-text
  // segment, and excluding just the slash let a `?` through — after which the
  // path is concatenated straight into the upstream URL below, so the caller's
  // own query string arrives AHEAD of `forwarded` and defeats all three guards
  // in this file at once: the `params` allowlist, MAX_Q_LEN and MAX_PARAM_LEN.
  // `path=/feed/podcast/<guid>?q=<anything>` was a free-text parameter of any
  // length on its way to a SQL LIKE, and `?j=1`, `?j=2`, … were unlimited
  // distinct CDN keys for one document, which is the amplification the `q`
  // note below says the per-path scoping exists to prevent. `#` is excluded on
  // the same argument, from the other end: it would silently truncate.
  { pattern: /^\/feed\/podcast\/[^/?#]{1,256}$/, sMaxAge: 60 },
  { pattern: /^\/feed\/episode\/[^/?#]{1,256}$/, sMaxAge: 60 },
  // Per-visitor pages: still shared (a boost explorer is public), but a shorter
  // window so a fresh boost shows up promptly.
  { pattern: /^\/feed\/by-author\/[0-9a-f]{64}$/, sMaxAge: 15 },
  { pattern: /^\/feed\/mentioning\/[0-9a-f]{64}$/, sMaxAge: 15 },
  { pattern: /^\/zaps\/received\/[0-9a-f]{64}$/, sMaxAge: 15 },
  { pattern: /^\/profiles$/, sMaxAge: 300 },
  // Name-prefix search for the @-mention picker. Same window as /profiles: the
  // answer is identical for every visitor, and a two-or-three character prefix
  // has a high edge hit rate, which is the point — the alternative is a
  // database query per keystroke per visitor. The corpus turns over slowly, so
  // a 300s stale "no match" costs a newly-indexed name a few minutes of
  // invisibility in an autocomplete.
  //
  // `q` is scoped to THIS route. It is free text on its way into a SQL LIKE
  // pattern and a cache key, so the generic 8192-character bound below is far
  // too loose for it; the service normalises and truncates again on its side.
  { pattern: /^\/profiles\/search$/, sMaxAge: 300, params: new Set(['q', 'limit']) },
  // Reposts answer "has THIS viewer already reposted these notes", so the
  // answer is per-viewer and must not be shared by the CDN.
  { pattern: /^\/reposts$/, sMaxAge: 0 },
];

// Only these may be forwarded, and each is bounded. `ids` and `pubkeys` are
// comma-separated hex lists that the service caps again on its own side.
//
// A route may narrow or replace this with its own `params` — see the Allowed
// type. Add a new name HERE only when every allowed path should carry it.
const DEFAULT_PARAMS = new Set(['limit', 'until', 'ids', 'pubkeys', 'pubkey']);

/** Bound on one forwarded value. A route wanting something tighter says so. */
const MAX_PARAM_LEN = 8192;
const MAX_Q_LEN = 64;

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
      const allowedHere = match.params ?? DEFAULT_PARAMS;
      const cap = k === 'q' ? MAX_Q_LEN : MAX_PARAM_LEN;
      if (k !== 'path' && allowedHere.has(k) && v.length <= cap) forwarded.set(k, v);
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
