import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AppHeader } from '@/components/app-header';
import { PlaylistMaker } from '@/components/community/playlist-maker';
import { BRAND } from '@/lib/brand';
import { COMMUNITY_PLAYLISTS_ON } from '@/lib/curated-playlists';

// Community playlists are behind one switch; with it off the route does not exist.
// No bottom padding: the layout footer is the one clearance for the mini-player and
// the dock (docs/ui.md).
export const metadata: Metadata = {
  title: `Make a playlist — ${BRAND.displayName}`,
  description: 'Pick songs and publish a playlist any Podcasting 2.0 app can follow.',
};

export default function Page() {
  if (!COMMUNITY_PLAYLISTS_ON) notFound();
  return (
    <>
      <AppHeader />
      <main className="max-w-7xl mx-auto px-4 pt-8">
        <PlaylistMaker />
      </main>
    </>
  );
}
