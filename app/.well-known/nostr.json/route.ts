import { NextResponse } from 'next/server';
import { sitePubkey } from '@/lib/nostr/site-key';
import { DEFAULT_RELAYS } from '@/lib/nostr/relays';
import { rateLimit } from '@/lib/rate-limit';

// NIP-05: maps the root identifier `_@boostmebitch.com` (clients render it as
// the bare domain "boostmebitch.com") to the site's Nostr pubkey, giving the
// app identity a verified name@domain badge. The pubkey is derived from
// SITE_NOSTR_SK so it always matches the key that signs the site's boost notes.
//
// Also returns the optional NIP-05 `relays` hint (pubkey → relay list) so a
// client that resolves the identity here immediately knows where the site
// writes its notes — the same DEFAULT_RELAYS its kind:10002 declares.
//
// NIP-05 clients fetch this cross-origin, so it must be CORS-open. When the key
// isn't configured, `names` is empty (nothing to verify) rather than an error.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
} as const;

export async function GET(req: Request) {
  const limited = rateLimit(req, 'nostr-json', 120);
  if (limited) return limited;
  const pk = sitePubkey();
  const names: Record<string, string> = {};
  const relays: Record<string, string[]> = {};
  if (pk) {
    // NIP-05 clients query ?name=<localpart>; we only serve the root `_`.
    const name = new URL(req.url).searchParams.get('name');
    if (!name || name === '_') {
      names['_'] = pk;
      relays[pk] = [...DEFAULT_RELAYS];
    }
  }
  return NextResponse.json(
    { names, relays },
    { headers: { ...CORS, 'Cache-Control': 'public, max-age=3600' } },
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
