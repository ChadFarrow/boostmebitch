import { NextResponse } from 'next/server';
import { buildAssetLinks } from '@/lib/assetlinks';
import { rateLimit } from '@/lib/rate-limit';

// Digital Asset Links: tells Android that the Trusted Web Activity published
// on Zapstore is allowed to represent this origin. Chrome fetches this at
// launch; without a matching statement the app still runs, but it opens with a
// URL bar across the top and looks like a browser rather than an app.
// Reasoning and the release runbook are in docs/android.md.
//
// The package id and fingerprint come from the ENVIRONMENT, not from source.
// Two reasons, and the second is the load-bearing one:
//
//   - the fingerprint identifies a signing key that does not exist in this
//     repo and must never be committed alongside it;
//   - a key rotation is then a Vercel environment change, with no deploy and
//     no code review standing between a broken app and its fix. Both
//     fingerprints ride in ANDROID_CERT_SHA256 at once during the overlap,
//     because the build already on people's phones is signed by the old one.
//
// Unset, or malformed, serves `[]` — a well-formed "no app is authorized" —
// the same way .well-known/nostr.json serves empty `names` when SITE_NOSTR_SK
// is absent. buildAssetLinks owns that decision and npm run check:assetlinks
// pins it.
//
// CAUTION: Digital Asset Links does NOT follow redirects, and the apex
// 307-redirects to www (see docs/ops.md). So the app's host must be
// www.boostmebitch.com — the host app/layout.tsx's metadataBase and
// bmbLandingUrl() already use — and the apex must not be listed as an
// additional trusted origin, because verification there can never succeed.
//
// Android fetches this cross-origin from a context with no page behind it, so
// it must be CORS-open like the NIP-05 document beside it.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
} as const;

export async function GET(req: Request) {
  // The `req` read here is also what keeps this route DYNAMIC. Drop the rate
  // limit as pointless on a static JSON document and Next may prerender the
  // handler, baking the BUILD-TIME environment into a static asset — after
  // which rotating ANDROID_CERT_SHA256 in the dashboard changes nothing until
  // the next deploy, silently, which is the failure mode this route's whole
  // env-driven design exists to avoid.
  const limited = rateLimit(req, 'assetlinks', 120);
  if (limited) return limited;
  const statements = buildAssetLinks(
    process.env.ANDROID_PACKAGE_ID,
    process.env.ANDROID_CERT_SHA256,
  );
  return NextResponse.json(statements, {
    headers: { ...CORS, 'Cache-Control': 'public, max-age=3600' },
  });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
