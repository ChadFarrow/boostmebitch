import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the workspace root so Next doesn't pick up an unrelated lockfile elsewhere
  // on disk (the parent dir has a bun.lock that's nothing to do with this app).
  outputFileTracingRoot: __dirname,
  // NO `images.remotePatterns`. It held `{ protocol: 'https', hostname: '**' }`,
  // which turned `/_next/image` into an open image proxy for the entire web:
  // anyone could call `/_next/image?url=https://any-host/...` and have this
  // server fetch it, optimize it, and serve it back from this domain, cached on
  // our CDN and billed to us.
  //
  // Three reasons it had to go, and none of them cost anything:
  //   1. It's a server-side fetch to an attacker-chosen host that bypasses
  //      `safeFetch` entirely — the guard every other outbound fetch of a
  //      remote URL goes through, precisely to re-validate each redirect hop.
  //   2. It feeds attacker-supplied bytes into sharp/libvips, which currently
  //      carries four high-severity CVEs (`npm audit`). Without the wildcard,
  //      the only thing that decoder ever sees is our own `public/hero.jpg`,
  //      so the advisory stops being reachable.
  //   3. It was never used. The app has exactly ONE <Image>, in app/layout.tsx,
  //      with `src="/hero.jpg"` — a local file. Local images under /public need
  //      no remotePatterns. Every REMOTE image in this app (podcast artwork,
  //      profile avatars, live-block covers) deliberately renders through a
  //      bare <img> because the host is arbitrary, which is exactly why the
  //      allowlist was empty of real consumers.
  //
  // If a remote host ever genuinely needs optimizing, add that ONE hostname
  // here. Never restore the `**` wildcard.
  //
  // The block below is deliberately format-only and carries NO `remotePatterns`
  // key, so everything above still holds: the only thing the sharp/libvips
  // decoder ever sees is our own public/hero.jpg.
  images: {
    // Next's default is `['image/webp']` — AVIF is NOT served unless it's named
    // here, even when the browser's Accept header offers it. The hero is the
    // LCP element on every route (app/layout.tsx renders it `fill priority` in
    // the ROOT layout), so this is the one image where the format matters.
    // Order is preference order: AVIF first, WebP for browsers that refuse it.
    //
    // Measured against a real production server (`next build && next start`),
    // public/hero.jpg at w=1920, bytes actually served:
    //
    //     q=75   webp 118,462   avif  97,008   → AVIF 18% smaller
    //     q=60   webp  97,686   avif  53,224   → AVIF 45% smaller
    //     q=40   webp  74,306   avif  24,565   → AVIF 66% smaller
    //
    // Combined with the hero's own `quality={40}`, the LCP element went from
    // 118,462 bytes (the pre-change default: webp at q=75) to 24,565 — a 79%
    // reduction. Browsers without AVIF get the 74,306-byte WebP, still 37%
    // better than before.
    //
    // MEASURE AGAINST A PRODUCTION SERVER, not against sharp directly. Encoding
    // this image with sharp's own default AVIF options suggested AVIF was 47%
    // LARGER than WebP at q=75 — the opposite of what Next actually ships,
    // because Next drives the encoder with its own effort/quality settings.
    // A local sharp benchmark is not evidence about this pipeline.
    formats: ['image/avif', 'image/webp'],
  },
  // Which user agents get the Open Graph tags in the `<head>`.
  //
  // Next 15 STREAMS metadata: `generateMetadata` runs while the shell is
  // already flushing, so for an ordinary user agent the `<meta>` tags land in
  // the BODY and the browser hoists them. Only a user agent matching Next's
  // built-in list gets a blocking render with the tags in the head. Measured on
  // the production deploy, same URL, one request each:
  //
  //     UA `Twitterbot/1.0`   og:title at byte  5761, </head> at 7398  → in head
  //     UA curl's default     og:title at byte 22251, </head> at 4024  → in body
  //
  // A link-preview fetcher reads the head and stops. So a boost note's
  // `?podcast=&episode=` deep link unfurled as a blank card with the hostname
  // for its title — in jumble, whose fetcher is `scout.jumble.social`; calling
  // that service directly returned `title: null, description: null, image:
  // null` beside our favicon, which is what "reached the site, read the wrong
  // part" looks like. Clients whose fetcher sends a listed UA were unaffected
  // the whole time, which is what made it look like one client's bug.
  //
  // The setting REPLACES Next's list rather than extending it, so the built-in
  // pattern is copied verbatim (from
  // `next/dist/shared/lib/router/utils/html-bots.js`, Next 15.5.20) and the
  // generic-fetcher words are appended. **Re-copy it when Next is upgraded** —
  // dropping a bot from this list costs a preview card nobody will report.
  //
  // The appended words are safe against a real browser: no Chrome, Safari,
  // Firefox or Edge UA contains any of them. The cost of a match is a blocking
  // render — slower first byte for that request, and nothing at all for a
  // browser, which matches none of them.
  htmlLimitedBots:
    /[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight|bot|crawler|spider|preview|unfurl|scout|curl|wget|axios|undici|node-fetch|got |okhttp|python-requests|aiohttp|go-http-client|java\/|libwww|httpx/i,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // HSTS. Vercel sets this automatically on *.vercel.app but NOT on a
          // custom apex, which is where this app actually serves from — so
          // without it the canonical domain had no HSTS at all. Two years,
          // subdomains included: pay.boostmebitch.com (the LNbits instance the
          // lnurlp rewrite points at) should never be reachable over plain http
          // either. No `preload` — that's a one-way door and belongs in a
          // deliberate submission, not a config edit.
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains',
          },
          // COOP, and it MUST be `same-origin-allow-popups`, not `same-origin`.
          // Google Sign-In runs through GIS's popup (`initTokenClient` in
          // lib/nostr/google-auth.ts), and the popup reports its result back
          // through the opener relationship. Plain `same-origin` severs that,
          // so sign-in would hang on a popup that never answers — Google's own
          // guidance says to use the allow-popups form for exactly this. The
          // variant still cuts off any window a THIRD party opens us in, which
          // is the part worth having.
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
          // Deliberately NO Cross-Origin-Resource-Policy. Two of our endpoints
          // exist to be read cross-origin — `.well-known/nostr.json` (NIP-05
          // verification, by every Nostr client) and `.well-known/keysend`
          // (by other podcast apps' payers) — and both send
          // `Access-Control-Allow-Origin: *` on purpose. CORP is scoped to
          // no-cors subresource loads so it shouldn't reach a CORS fetch, but
          // the upside here is near zero (this app serves no sensitive
          // subresources to embed) and the downside is silently breaking a
          // verification path we can only observe from other people's clients.
          // Clipboard intentionally untouched: the Amber signer reads and the
          // Share button writes via same-origin JS, covered by the default
          // `self` allowlist.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // Deliberately NOT a script-src CSP. Two hard blockers, both
          // structural rather than laziness:
          //   1. The FOUC blocker in app/layout.tsx is an inline <script> that
          //      must run before first paint, so script-src would need nonce
          //      plumbing through the App Router — and 'unsafe-inline' instead
          //      would defeat the point.
          //   2. connect-src can't be constrained. The app connects to
          //      arbitrary user-supplied relays (wss://*), arbitrary podcast
          //      feed/chapter/transcript hosts, and arbitrary LNURL servers by
          //      design. Without a connect-src allowlist, injected script can
          //      still exfiltrate, so a script-src alone would read as more
          //      protection than it delivers.
          // What IS worth setting are the directives that cost nothing and
          // close real injection vectors: base-uri stops a <base> tag from
          // repointing every relative URL, object-src kills plugin embeds,
          // frame-ancestors backs up X-Frame-Options for browsers that prefer
          // CSP, and form-action stops an injected <form> posting somewhere
          // else — the one exfiltration route that needs no script at all, and
          // so the one directive that still bites despite connect-src being
          // unconstrainable. This app has no cross-origin form submissions:
          // every write goes through fetch to our own routes. This matters more
          // now that the origin can hold a signing key (see
          // lib/nostr/local-key-store.ts).
          {
            key: 'Content-Security-Policy',
            value:
              "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
          },
        ],
      },
    ];
  },
};
export default nextConfig;
