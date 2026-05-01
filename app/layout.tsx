import type { Metadata, Viewport } from 'next';
import Image from 'next/image';
import './globals.css';
import { ServiceWorkerRegister } from '@/components/sw-register';

export const metadata: Metadata = {
  metadataBase: new URL('https://boostmebitch.vercel.app'),
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // bg-ink on <html> makes the canvas dark so there's no white flash before
    // the hero image loads. We deliberately keep <body> background-free so the
    // fixed image layer below is visible through it (setting bg on <body>
    // propagates to the canvas and would cover the image).
    <html lang="en" className="bg-ink">
      <body className="min-h-screen antialiased">
        <div aria-hidden className="fixed inset-0 pointer-events-none">
          <Image
            src="/hero.jpg"
            alt=""
            fill
            priority
            sizes="100vw"
            className="object-cover object-center"
          />
          <div className="absolute inset-0 bg-ink/75" />
        </div>
        <div className="relative z-0">
          {children}
        </div>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
