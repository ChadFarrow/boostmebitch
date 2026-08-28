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
    // and DPR EXACTLY. Without a match it shows a white screen during launch —
    // on an app whose every surface is near-black — so this list is
    // intentionally redundant: every iPhone shipped from 2018 (XR/XS) through
    // the 17 Pro Max and the Air finds a hit. iPad / older phones fall back to
    // white, which is acceptable for "basic" iOS PWA support.
    //
    // Entries are shared wherever a geometry is: the iPhone 16 is 393x852, the
    // same as the 14 Pro, and the 16 Plus is 430x932, the same as the 15 Plus —
    // so neither needs its own file. Only three geometries were genuinely new.
    //
    // The PNGs are generated, not drawn: `node scripts/make-splash.mjs`, whose
    // DEVICES table is the source for this list. Add a device THERE, run it,
    // then mirror the entry here — and `--check` re-derives the art's geometry
    // from disk, so a hand-edited PNG or a stale one fails rather than quietly
    // shipping a mispositioned logo.
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
      // iPhone 16 Pro / 17 / 17 Pro — 402 × 874 @3x
      {
        url: '/splash/iphone-16pro-17-17pro.png',
        media:
          '(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)',
      },
      // iPhone Air — 420 × 912 @3x
      {
        url: '/splash/iphone-air.png',
        media:
          '(device-width: 420px) and (device-height: 912px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)',
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
      // iPhone 16 Pro Max / 17 Pro Max — 440 × 956 @3x
      {
        url: '/splash/iphone-16promax-17promax.png',
        media:
          '(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)',
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
  // ONE value, deliberately — do NOT split this into `prefers-color-scheme`
  // media variants. This app's theme is a manual `bmb:theme` localStorage
  // toggle, read by the FOUC-blocker below and written by <ThemeToggle>; it is
  // not derived from the OS preference. A media-keyed theme-color would
  // therefore be wrong for every user whose OS and app themes disagree — light
  // OS with the app left dark is the common case — and it would be wrong in the
  // direction that matters, since the browser paints its chrome that colour
  // while the page underneath is the other one.
  //
  // The iOS half of this problem is not solved here at all: `black-translucent`
  // makes iOS draw the status bar in white REGARDLESS of theme-color, so light
  // mode needs a real dark surface behind those glyphs. See the status-bar
  // strip in the body below.
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
        {/* The iOS status-bar backdrop, and it is a legibility fix rather than
            decoration.

            `appleWebApp.statusBarStyle` above is `black-translucent`, which is
            what puts the app edge-to-edge under the notch — and it makes iOS
            draw the clock, battery and signal glyphs in WHITE, always, with no
            way to ask for the dark set. That is fine while the page behind them
            is `#0a0a08`. It is not fine in light mode, where `--ink` flips to
            `253 250 243` (globals.css) and white-on-cream leaves the status bar
            effectively invisible in the installed app.

            `theme-color` cannot fix it: iOS ignores it for the status bar under
            this style. So the repair is a real surface — a strip exactly as tall
            as the top safe-area inset, painted the dark ink colour in BOTH
            themes, for the white glyphs to sit on.

            Three properties, each load-bearing:

            - The colour is HARD-CODED, not `bg-ink`. In dark mode it matches the
              page and the strip is invisible; in light mode it is the contrast.
              One code path, no theme conditional, nothing to keep in sync.
            - It is ZERO-HEIGHT wherever the inset is 0 — desktop, Android, and
              iOS Safari with its own chrome — so it costs nothing off-iOS and
              needs no display-mode detection.
            - `z-[70]`, which is above `<ModalShell>`'s `z-[60]` (the previous
              maximum) and above <FullscreenPlayer>'s `z-50`. That is deliberate
              and not an accident of ordering: BOTH of those paint `bg-ink`, so
              both go cream in light mode, and a strip underneath them would be
              covered exactly when a modal is open. The status bar has to stay
              readable over every surface, so this is the topmost layer in the
              app. Anything new that outranks it re-opens this bug. */}
        <div
          aria-hidden
          className="fixed inset-x-0 top-0 z-[70] pointer-events-none"
          style={{ height: 'env(safe-area-inset-top, 0px)', background: '#0a0a08' }}
        />
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
            {/* `inline-block py-1.5` is a TOUCH TARGET, not spacing — the same
                repair <CollapsibleHeading> documents. text-[11px] is a 14px
                line box here, under WCAG 2.5.8's 24x24 floor, and this footer
                renders on EVERY route. An inline <a> ignores vertical padding
                for layout, so the display change is what makes the box real. */}
            <a
              href="/privacy"
              className="inline-block py-1.5 text-[11px] text-muted hover:text-bone"
            >
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
