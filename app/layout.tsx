import type { Metadata, Viewport } from 'next';
import Image from 'next/image';
import { Bricolage_Grotesque, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// Self-hosted at build time via next/font, NOT a CSS @import of
// fonts.googleapis.com. The @import this replaced sat on line 1 of globals.css,
// which serialized the critical path four hops deep across three origins:
// HTML → globals.css → fonts.googleapis.com (CSS) → fonts.gstatic.com (files),
// each with its own DNS + TLS handshake, all of it blocking first paint, and
// with no preconnect to soften it. next/font emits the font files as
// same-origin immutable assets referenced directly from the initial HTML, so
// the two external origins disappear entirely.
//
// It also generates a size-adjusted local fallback, which removes the layout
// shift `display: swap` was causing on every cold load.
//
// `axes: ['opsz']` is deliberate: the old URL requested the optical-size axis
// (opsz,wght@12..96), and next/font ships only `wght` for a variable font
// unless the other axes are named. Dropping it would be a smaller download but
// a visible change to the display face, so it stays — the win here is removing
// the origin chain, not trimming an axis.
const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  axes: ['opsz'],
  display: 'swap',
  variable: '--font-display',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});
import { ServiceWorkerRegister } from '@/components/sw-register';
import { Player } from '@/components/player';
import { FavoritesPrivacyPrompt } from '@/components/favorites-privacy';
import { ErrorBoundary } from '@/components/error-boundary';

export const metadata: Metadata = {
  // The canonical origin, and it must be the `www` form: the apex 307-redirects
  // to it, and metadataBase is what turns the relative asset paths below (OG
  // image, icons) into the absolute URLs an unfurler fetches. Pointing it at
  // the vercel.app host — as it did — meant every Nostr/social card pulled its
  // artwork from a domain the app doesn't otherwise use, while the boost-note
  // deep links, NIP-05 and the OAuth origins all say boostmebitch.com.
  metadataBase: new URL('https://www.boostmebitch.com'),
  title: 'Boost Me Bitch — Podcast Boost Station',
  description: 'Search, listen, and boost Podcasting 2.0 shows over Lightning. Sign in with Nostr.',
  manifest: '/manifest.json',
  applicationName: 'Boost Me Bitch',
  appleWebApp: {
    capable: true,
    title: 'Boost Me Bitch',
    statusBarStyle: 'black-translucent',
    // iOS picks the splash whose media query matches the device's CSS dimensions
    // and DPR. Without a match it shows a white screen during launch — so this
    // list is intentionally redundant: every iPhone shipped from 2018 (XR/XS)
    // through 2023 (15 Pro Max) finds a hit. iPad / older phones fall back to
    // white, which is acceptable for "basic" iOS PWA support.
    startupImage: [
      // iPhone SE 2nd/3rd gen, iPhone 6/7/8 — 375 × 667 @2x
      {
        url: '/splash/iphone-se-8.png',
        media:
          '(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)',
      },
      // iPhone XR / 11 — 414 × 896 @2x
      {
        url: '/splash/iphone-xr-11.png',
        media:
          '(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)',
      },
      // iPhone X / XS / 11 Pro / 12 mini / 13 mini — 375 × 812 @3x
      {
        url: '/splash/iphone-x-xs-11pro-12mini-13mini.png',
        media:
          '(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)',
      },
      // iPhone 12 / 13 / 14 / 12 Pro / 13 Pro — 390 × 844 @3x
      {
        url: '/splash/iphone-12-13-14.png',
        media:
          '(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)',
      },
      // iPhone 14 Pro / 15 / 15 Pro — 393 × 852 @3x
      {
        url: '/splash/iphone-14pro-15-15pro.png',
        media:
          '(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)',
      },
      // iPhone 12 Pro Max / 13 Pro Max / 14 Plus — 428 × 926 @3x
      {
        url: '/splash/iphone-12-13promax-14plus.png',
        media:
          '(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)',
      },
      // iPhone 14 Pro Max / 15 Plus / 15 Pro Max — 430 × 932 @3x
      {
        url: '/splash/iphone-14promax-15plus-15promax.png',
        media:
          '(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)',
      },
    ],
  },
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  openGraph: {
    title: 'Boost Me Bitch — Podcast Boost Station',
    description: 'Search, listen, and boost Podcasting 2.0 shows over Lightning. Sign in with Nostr.',
    images: [{ url: '/hero.jpg', width: 2400, height: 1339, alt: 'Boost Me Bitch' }],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Boost Me Bitch',
    description: 'Search, listen, and boost Podcasting 2.0 shows over Lightning.',
    images: ['/hero.jpg'],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0a0a08',
};

// FOUC-blocker for light mode. Reads bmb:theme synchronously and sets
// data-theme on <html> before first paint — without it, light-mode users see
// a dark flash on every navigation while React hydrates. Stays inline so it
// runs before any CSS or JS bundle. The default (dark) needs no setup since
// :root in globals.css holds the dark values.
const FOUC_BLOCKER = `
try {
  if (localStorage.getItem('bmb:theme') === 'light') {
    document.documentElement.dataset.theme = 'light';
  }
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The page background lives on <html> in globals.css (background:
    // rgb(var(--ink))), so there's no white flash before the hero image
    // loads. We deliberately keep <body> background-free so the fixed image
    // layer below is visible through it — setting bg on <body> propagates
    // to the canvas and would cover the image.
    // suppressHydrationWarning: the FOUC-blocker script mutates
    // documentElement.dataset.theme before React hydrates. Without this flag
    // React logs a noisy "extra attribute on the server: data-theme" warning.
    // Scoped to <html> so component-level mismatches still surface normally.
    // The two font variables land on <html> so the --font-display /
    // --font-mono custom properties are in scope for globals.css and for every
    // Tailwind font-display / font-mono utility, both of which now resolve
    // through var() rather than naming the family literally.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${bricolage.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        {/* Warm the TCP + TLS handshake to Google's script host, without
            fetching anything. The GIS script itself stays lazy (it is fetched
            when the account menu opens — see preloadGis), because a signed-out
            visitor who never taps Sign in should not pay for a third-party
            script. But that leaves only the menu-reading time to load it, and
            a tap arriving before it lands is a tap that cannot open the consent
            popup. The handshake is the slow half on a cold mobile connection,
            so paying it here is what makes the later fetch land in time.
            No request is sent and no cookie rides along. */}
        <link rel="preconnect" href="https://accounts.google.com" crossOrigin="" />
        <script dangerouslySetInnerHTML={{ __html: FOUC_BLOCKER }} />
      </head>
      <body className="min-h-screen antialiased">
        <div aria-hidden className="fixed inset-0 pointer-events-none">
          {/* quality={40}, not the default 75. This is the LCP element on every
              route, and it renders under the `bg-ink/75` overlay directly
              below — a 75% wash that mutes it to a texture. Encoding detail the
              overlay then throws away is the most expensive byte on the page.
              Measured on a production server at w=1920: 118,462 bytes at the
              old default (webp q=75) vs 24,565 served now, with the AVIF
              negotiation in next.config.mjs. If the overlay opacity is ever
              lowered, revisit this number — the two are coupled. */}
          <Image
            src="/hero.jpg"
            alt=""
            fill
            priority
            quality={40}
            sizes="100vw"
            className="object-cover object-center"
          />
          <div className="absolute inset-0 bg-ink/75" />
        </div>
        <div className="relative z-0">
          {children}
          {/* Google OAuth verification requires the privacy policy to be linked
              from the homepage, with the same URL entered on the consent
              screen. Living in the layout means it's on every page including
              the homepage. `pb-28` clears the fixed mini-player. */}
          <footer className="px-4 pb-28 pt-10 text-center">
            <a href="/privacy" className="text-[11px] text-muted hover:text-bone">
              Privacy Policy
            </a>
          </footer>
        </div>
        {/* App-global player — mounted in the layout so playback (and the
            fullscreen player overlay) survives route changes, e.g. navigating
            between the browse page and the /stream/<naddr> page.

            Wrapped, because being in the layout puts it OUTSIDE app/error.tsx,
            which is a route-segment boundary and only covers app/page.tsx's
            tree. <Player> is the most stateful component here and every input it
            takes — enclosure URLs, HLS manifests, chapter JSON, value blocks —
            comes from an arbitrary third-party feed, so a throw was a
            whole-document "Application error" that took the browse UI with it.
            The fallback is null: losing playback should cost you the player, not
            the page. */}
        <ErrorBoundary label="Player">
          <Player />
        </ErrorBoundary>
        {/* Mounted in the LAYOUT, beside <Player>, and not in <AppHeader>.
            `onFavoritesModeNeeded` is a single module-level slot that only
            exists while the component registering it is mounted, and
            <AppHeader> renders on `/` and /favorites ONLY — while <Player>'s
            <FullscreenPlayer> renders hearts on EVERY route. So a ♡ pressed on
            /npub/<npub>, /live/<npub> or /stream/<naddr> by a user with no
            recorded mode reached `promptForMode?.()` as `null`: the heart
            filled, the store wrote through to localStorage, no dialog appeared,
            and the favorite reached no relay — silently, until the user
            happened to re-toggle the same item back on `/`.
            It portals to document.body, so it contributes no layout here. */}
        <FavoritesPrivacyPrompt />
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
