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
      {/* `max-w-7xl px-4` — the same measure every <section> in <HomePage>
          uses. It was `max-w-5xl`, which reads fine for a column of prose and
          wrong for a library: the two routes share a header pinned to the wider
          measure, so the content below it started at a different left edge on
          each and the page looked inset by mistake rather than by design. */}
      <main className="max-w-7xl mx-auto px-4 pt-8 pb-32">
        <FavoritesPage />
      </main>
    </>
  );
}
