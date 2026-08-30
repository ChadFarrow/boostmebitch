import type { Metadata } from 'next';
import { AppHeader } from '@/components/app-header';
import { PlaylistsPage } from '@/components/playlists-page';
import { BRAND } from '@/lib/brand';

// A real route rather than another branch of `<HomePage>`'s store-driven view
// switch, for the same reason `/favorites` is one: the collection had no URL to
// give anyone. It opened as an aside on `/` behind a `?publisher=` param that
// `history.replaceState` wrote, so it was neither a page you could bookmark nor
// one the back button could leave.
//
// `/` keeps that aside — a third-party publisher feed found by searching still
// opens in place, and every `?publisher=` link already shared keeps working.
// This route is the curated collection only.
//
// The app-global <Player> is mounted in app/layout.tsx, so navigating here from
// a playing episode does not interrupt it. `pb-32` clears the mini-player bar.
export const metadata: Metadata = {
  title: `Playlists — ${BRAND.displayName}`,
  description: 'Podcasting 2.0 playlists — tracks from hundreds of independent feeds.',
};

export default function Page() {
  return (
    <>
      <AppHeader />
      {/* `max-w-7xl px-4` — the same measure `/favorites` and every <HomePage>
          section uses. The three routes share a header pinned to that measure,
          so anything narrower starts the content at a different left edge than
          the header above it. */}
      <main className="max-w-7xl mx-auto px-4 pt-8 pb-32">
        <PlaylistsPage />
      </main>
    </>
  );
}
