import type { Metadata } from 'next';
import { AppHeader } from '@/components/app-header';
import { FavoritesPage } from '@/components/favorites-page';

// A real route rather than another branch of `<HomePage>`'s store-driven view
// switch, for the same reason `/npub/<npub>` is one: those views have no URL to
// give anyone, and this is a page people want to bookmark and come back to.
//
// The app-global <Player> is mounted in app/layout.tsx, so navigating here from
// a playing episode does not interrupt it. `pb-32` clears the mini-player bar.
export const metadata: Metadata = {
  title: 'Favorites — Boost Me Bitch',
  description: 'Your saved shows, albums, episodes and tracks.',
};

export default function Page() {
  return (
    <>
      <AppHeader />
      <main className="max-w-5xl mx-auto px-4 pt-8 pb-32">
        <FavoritesPage />
      </main>
    </>
  );
}
