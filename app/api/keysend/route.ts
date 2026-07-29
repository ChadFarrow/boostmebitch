import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { safeFetch } from '@/lib/safe-fetch';

// Server-side proxy for a lightning address's `.well-known/keysend` document.
//
// This MUST be proxied, unlike `.well-known/lnurlp`. LNURL is browser-facing
// by design so those endpoints universally send Access-Control-Allow-Origin;
// the keysend well-known is a server-to-server convention (podcast apps doing
// the lookup from their backend) and providers generally set no CORS headers
// on it. A direct browser fetch is therefore CORS-blocked, which the client's
// catch turns into "no keysend endpoint" — silently downgrading every boost
// back to LNURL. Same reason /api/chapters exists.
//
// Returns the upstream JSON verbatim so the client parser
// (lib/v4v/keysend-lookup.ts) stays the single source of truth.
export async function GET(req: Request) {
  const limited = rateLimit(req, 'keysend', 120);
  if (limited) return limited;

  const addr = new URL(req.url).searchParams.get('addr')?.trim().toLowerCase();
  if (!addr) return NextResponse.json({ error: 'missing addr' }, { status: 400 });
  if (addr.length > 256) return NextResponse.json({ error: 'invalid addr' }, { status: 400 });

  const [name, domain] = addr.split('@');
  if (!name || !domain || addr.indexOf('@') !== addr.lastIndexOf('@')) {
    return NextResponse.json({ error: 'invalid addr' }, { status: 400 });
  }
  // Reject anything that isn't a bare hostname — a value carrying a port,
  // path, credentials or userinfo would let a feed steer the fetch somewhere
  // other than the address it claims to be. safeFetch still guards the
  // resolved target, this just keeps the URL we build honest.
  let host: string;
  try {
    host = new URL(`https://${domain}`).hostname;
  } catch {
    return NextResponse.json({ error: 'invalid addr' }, { status: 400 });
  }
  if (host !== domain) return NextResponse.json({ error: 'invalid addr' }, { status: 400 });

  return withErrorHandling(async () => {
    const res = await safeFetch(
      `https://${host}/.well-known/keysend/${encodeURIComponent(name)}`,
      {
        headers: { 'User-Agent': process.env.APP_NAME ?? 'boostmebitch/0.1' },
        next: { revalidate: 3600 },
        // Shorter than the client's own budget so the proxy answers before the
        // caller gives up. This runs inside a boost the user is waiting on.
        signal: AbortSignal.timeout(3500),
      },
    );
    // Most addresses are LNURL-only, so a non-2xx here is the ordinary case,
    // not a fault. 404 keeps it distinguishable from a real upstream error
    // without dressing "no endpoint" up as a 5xx.
    if (!res.ok) {
      return NextResponse.json({ error: 'no keysend endpoint' }, { status: 404 });
    }
    // A 200 is not a promise of JSON. SPA-hosted domains serve their app shell
    // for unknown paths with a 200 (primal.net does exactly this), so parsing
    // straight into res.json() threw and withErrorHandling dressed "this
    // address has no keysend endpoint" up as a 500. Same absent-endpoint case
    // as the branch above — answer it the same way.
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return NextResponse.json({ error: 'no keysend endpoint' }, { status: 404 });
    }
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=86400' },
    });
  }, 'keysend lookup failed');
}
