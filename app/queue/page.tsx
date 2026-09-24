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
// a playing episode does not interrupt it. No bottom padding: the layout
// footer is the one clearance for the mini-player and the dock (docs/ui.md).
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
      <main className="max-w-7xl mx-auto px-4 pt-8">
        <QueuePage />
      </main>
    </>
  );
}
