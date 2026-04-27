import type { Metadata } from 'next';
import Image from 'next/image';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://boostmebitch.vercel.app'),
  title: 'Boost Me Bitch — Podcast Boost Station',
  description: 'Search, listen, and boost Podcasting 2.0 shows over Lightning. Sign in with Nostr.',
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased bg-ink relative">
        <div aria-hidden className="fixed inset-0 -z-10">
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
        {children}
      </body>
    </html>
  );
}
