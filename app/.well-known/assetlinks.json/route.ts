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

// Declared, not inferred. This route's whole design is that rotating
// ANDROID_CERT_SHA256 in the Vercel dashboard takes effect with no deploy, and
// that only holds while the handler runs per request — a prerendered copy bakes
// the BUILD-TIME environment into a static asset, after which a rotation
// changes nothing and says nothing.
//
// It used to be the `req` read in the rate limiter that kept this dynamic,
// which made a security property depend on a side effect of an unrelated line:
// tidy the limiter away as pointless on a static JSON document and the route
// silently goes static. The declaration is the property stated outright, so it
// survives any edit to the body.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  // Deliberately far looser than the 120/min the two documents beside this one
  // use, because the caller is not a browser. Chrome does not fetch this from
  // the device: verification goes through Google's Digital Asset Links service,
  // so every request arrives from a small shared pool of Google IPs and buckets
  // into ONE `assetlinks:<ip>` key. A 429 there is a third silent way to fail
  // verification — no log on the device, none here, just a URL bar — which is
  // the exact outcome this file exists to prevent. The limit stays only as
  // abuse damping on an unauthenticated endpoint; it must never be the thing
  // that decides whether the app verifies.
  const limited = rateLimit(req, 'assetlinks', 6_000);
  if (limited) return limited;
  const statements = buildAssetLinks(
    process.env.ANDROID_PACKAGE_ID,
    process.env.ANDROID_CERT_SHA256,
  );
  // `no-store`, where .well-known/nostr.json and .well-known/keysend both cache
  // for an hour. The divergence is the point: those two answer a question whose
  // answer is stable, and this one is the live statement of which certificate
  // may speak for this origin. An hour of downstream caching works directly
  // against the rotation the env-driven design buys — a REMOVED fingerprint
  // keeps verifying and a newly ADDED one may not — and the release workflow
  // curls this same document to decide whether an APK is safe to publish, so a
  // cached copy can fail a correct rotation or pass a stale one.
  return NextResponse.json(statements, {
    headers: { ...CORS, 'Cache-Control': 'no-store' },
  });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
