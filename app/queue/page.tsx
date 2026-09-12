import type { Metadata } from 'next';
import { AppHeader } from '@/components/app-header';
import { QueuePage } from '@/components/queue-page';
import { BRAND } from '@/lib/brand';

// A real route, and the dock points at it — it replaced the Wallet tab there.
//
// It renders <AppHeader> like /favorites and /playlists do, which is not
// incidental: the header is where the wallet lives on the routes that have one,
// so putting it here keeps this route from being another surface with no way to
// reach a wallet.
//
// The app-global <Player> is mounted in app/layout.tsx, so navigating here from
// a playing episode does not interrupt it. `pb-32` clears the mini-player bar.
export const metadata: Metadata = {
  title: `Up Next — ${BRAND.displayName}`,
  description: 'The episodes you lined up to listen to next.',
};

export default function Page() {
  return (
    <>
      <AppHeader />
      {/* The same `max-w-7xl px-4` measure every other route under this header
          uses, so the content's left edge does not move between them. */}
      <main className="max-w-7xl mx-auto px-4 pt-8 pb-32">
        <div className="max-w-3xl">
          <QueuePage />
        </div>
      </main>
    </>
  );
}
