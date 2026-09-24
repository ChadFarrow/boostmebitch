import type { Metadata } from 'next';
import { AppHeader } from '@/components/app-header';
import { FavoritesPage } from '@/components/favorites-page';
import { BRAND } from '@/lib/brand';

// A real route rather than another branch of `<HomePage>`'s store-driven view
// switch, for the same reason `/npub/<npub>` is one: those views have no URL to
// give anyone, and this is a page people want to bookmark and come back to.
//
// The app-global <Player> is mounted in app/layout.tsx, so navigating here from
// a playing episode does not interrupt it.
//
// NO BOTTOM PADDING HERE. The layout footer carries the ONLY bottom clearance — its
// `calc(var(--dock-b) + 7rem)` sits under every route. A `pb-32` here on top
// of it was 128px of dead space that made a short page scroll (docs/ui.md).
export const metadata: Metadata = {
  title: `Favorites — ${BRAND.displayName}`,
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
      <main className="max-w-7xl mx-auto px-4 pt-8">
        <FavoritesPage />
      </main>
    </>
  );
}
