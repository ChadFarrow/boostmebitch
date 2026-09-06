import type { Metadata } from 'next';
import { BRAND } from '@/lib/brand';

// `/live/<npub>` is the link a host puts in a bio — it stays valid across
// broadcasts — so it is shared far more than `/stream/<naddr>` and deserves a
// title that names whose live link it is. The page is a client component.
function shortId(raw: string): string {
  return raw.length > 16 ? `${raw.slice(0, 12)}…${raw.slice(-4)}` : raw;
}

export async function generateMetadata({ params }: { params: Promise<{ npub: string }> }): Promise<Metadata> {
  const { npub } = await params;
  const id = shortId(decodeURIComponent(npub));
  return {
    title: `Live · ${id} — ${BRAND.displayName}`,
    description: `${id}'s live stream on Nostr, when they are on air.`,
  };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
