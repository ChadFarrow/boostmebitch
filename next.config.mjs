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
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
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
          // repointing every relative URL, object-src kills plugin embeds, and
          // frame-ancestors backs up X-Frame-Options for browsers that prefer
          // CSP. This matters more now that the origin can hold a signing key
          // (see lib/nostr/local-key-store.ts).
          {
            key: 'Content-Security-Policy',
            value: "base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
          },
        ],
      },
    ];
  },
};
export default nextConfig;
