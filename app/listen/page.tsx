import type { Metadata } from 'next';
import { AppHeader } from '@/components/app-header';
import { ListenPage } from '@/components/listen-page';
import { BRAND } from '@/lib/brand';

// A real route, and the dock points at it — it replaced the Wallet tab there,
// as `/queue`. It became `/listen` on 2026-10-01, when the play history joined
// Up Next under one tab; `app/queue/page.tsx` redirects here, so an old link or
// a bookmark in the installed app still lands.
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
  title: `Listen — ${BRAND.displayName}`,
  description: 'The episodes you lined up to listen to next, and the ones you already heard.',
};

export default function Page() {
  return (
    <>
      <AppHeader />
      {/* The same `max-w-7xl px-4` measure every other route under this header
          uses, so the content's left edge does not move between them. */}
      <main className="max-w-7xl mx-auto px-4 pt-8">
        <ListenPage />
      </main>
    </>
  );
}
