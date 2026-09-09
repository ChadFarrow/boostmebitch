import type { Metadata } from 'next';
import { AppHeader } from '@/components/app-header';
import { DownloadsPage } from '@/components/downloads-page';
import { BRAND } from '@/lib/brand';

// A real route rather than another branch of `<HomePage>`'s store-driven view
// switch, for the same reason `/favorites` is one: it is a place people come
// back to, and it is the only surface that can show what a download is costing
// them in space.
//
// The app-global <Player> is mounted in app/layout.tsx, so playing a row here
// does not navigate and does not interrupt anything. `pb-32` clears the
// mini-player bar; `max-w-7xl px-4` is the measure <AppHeader> is pinned to, so
// this route's content starts at the same left edge as every other one.
export const metadata: Metadata = {
  title: `Downloads — ${BRAND.displayName}`,
  description: 'Episodes saved to this device for listening without a connection.',
};

export default function Page() {
  return (
    <>
      <AppHeader />
      <main className="max-w-7xl mx-auto px-4 pt-8 pb-32">
        <DownloadsPage />
      </main>
    </>
  );
}
