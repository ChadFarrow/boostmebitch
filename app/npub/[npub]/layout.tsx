import type { Metadata } from 'next';
import { BRAND } from '@/lib/brand';

// The page is a client component and cannot export metadata, so the title
// lives one level up. `/npub/<npub>` is a permalink an artist puts in their bio
// — it unfurled and titled as the generic site card, which is the one place a
// stranger's first sight of this app is a title. The segment is shown in its
// short form; the page itself resolves nprofile / hex through `parseNpubInput`
// and this stays a label, never a lookup.
function shortId(raw: string): string {
  return raw.length > 16 ? `${raw.slice(0, 12)}…${raw.slice(-4)}` : raw;
}

export async function generateMetadata({ params }: { params: Promise<{ npub: string }> }): Promise<Metadata> {
  const { npub } = await params;
  const id = shortId(decodeURIComponent(npub));
  return {
    title: `Boosts · ${id} — ${BRAND.displayName}`,
    description: `Boosts sent and received by ${id}, on ${BRAND.displayName}.`,
  };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
