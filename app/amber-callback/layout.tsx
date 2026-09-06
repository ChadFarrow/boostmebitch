import type { Metadata } from 'next';
import { BRAND } from '@/lib/brand';

// Amber's landing page. A title so the tab Brave opens for it is not the
// generic one, and `noindex`: this URL exists only to be redirected to.
export const metadata: Metadata = {
  title: `Signing… — ${BRAND.displayName}`,
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
