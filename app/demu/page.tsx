import type { Metadata } from 'next';
import { AppHeader } from '@/components/app-header';
import { DemuPage } from '@/components/demu-page';
import { BRAND } from '@/lib/brand';

// Every self-hosted (DeMu) music album, newest track first — the place
// Homegrown Hits listeners used LNBeats for. A real route, like /playlists and
// /favorites, so it can be bookmarked and left with the back button.
// Design: docs/superpowers/specs/2026-11-15-demu-page-design.md.
//
// Same shell as /playlists: the header is pinned to `max-w-7xl px-4`, and a
// narrower main would start the list at a different left edge.
export const metadata: Metadata = {
  title: `DeMu — ${BRAND.displayName}`,
  description: 'Self-hosted Podcasting 2.0 music, newest first.',
};

export default function Page() {
  return (
    <>
      <AppHeader />
      <main className="max-w-7xl mx-auto px-4 pt-8">
        <DemuPage />
      </main>
    </>
  );
}
