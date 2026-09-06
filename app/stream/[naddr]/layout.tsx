import type { Metadata } from 'next';
import { BRAND } from '@/lib/brand';

// The page is a client component; the title lives here. A stream link is
// shared while the show is on, so the card should say "live stream" rather
// than the site's generic line. The naddr names the broadcast, not the host,
// and resolving it needs a relay — so this stays static.
export const metadata: Metadata = {
  title: `Live stream — ${BRAND.displayName}`,
  description: `A live stream on Nostr, playing in ${BRAND.displayName}.`,
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
