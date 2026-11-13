// Which browser origins may READ the Buddy deploy's two signing routes
// (`/api/nostr/site-sign`, `/api/nostr/zap-receipt-sign`).
//
// The Bitch site posts boost notes for songs from BMB-hosted playlists in
// Buddy's wording, signed by Buddy's site key, so its browser must be able to
// POST to Buddy and read the answer. CORS adds no capability: both routes are
// already public, rate-limited and validated, and a non-browser caller never
// needed CORS. It only lets a page on one of these origins read the reply.
//
// IMPORT-FREE ON PURPOSE (checked by `check:brand` via `scripts/import-free.mjs`):
// it takes the brand id as a PARAMETER instead of importing `BRAND`, so the
// check script loads the real module under plain Node and can test both
// brands. The Bitch deploy (`bmb`) opens nothing.

const BITCH_ORIGINS: readonly string[] = [
  'https://www.boostmebitch.com',
  'https://beta.boostmebitch.com',
];

/** Origins allowed to call this deploy's signing routes from a browser. */
export function crossBrandOrigins(brandId: 'bmb' | 'buddy'): readonly string[] {
  return brandId === 'buddy' ? BITCH_ORIGINS : [];
}

/**
 * Headers for ONE answer. An allowed origin gets the full set; anything else
 * (no Origin, a stranger, a look-alike, the wrong scheme, or the Bitch deploy)
 * gets `Vary: Origin` alone. Exact string match only: never a suffix or a
 * prefix test, and never `*`.
 */
export function corsHeaders(
  origin: string | null,
  brandId: 'bmb' | 'buddy',
): Record<string, string> {
  if (origin !== null && crossBrandOrigins(brandId).includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
  }
  return { Vary: 'Origin' };
}
