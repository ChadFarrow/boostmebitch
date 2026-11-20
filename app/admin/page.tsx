import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AppHeader } from '@/components/app-header';
import { AdminPlaylists } from '@/components/community/admin-playlists';
import { COMMUNITY_PLAYLISTS_ON } from '@/lib/curated-playlists';
import { BRAND } from '@/lib/brand';

// Community playlists are the only section, so with the switch off there is nothing to administer.
export const metadata: Metadata = {
  title: `Admin — ${BRAND.displayName}`,
  robots: { index: false },
};

export default function Page() {
  if (!COMMUNITY_PLAYLISTS_ON) notFound();
  return (
    <>
      <AppHeader />
      <main className="max-w-7xl mx-auto px-4 pt-8">
        <AdminPlaylists />
      </main>
    </>
  );
}
