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
