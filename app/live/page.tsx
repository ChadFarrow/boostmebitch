import type { Metadata } from 'next';
import { LivePage } from '@/components/live-page';
import { BRAND } from '@/lib/brand';

// The index beside `/live/<npub>`, which pins one host's current broadcast.
// A static segment and a dynamic child coexist fine in the App Router, and
// until now `/live` itself was a 404.
//
// The app-global <Player> is mounted in app/layout.tsx, so navigating here from
// a playing episode does not interrupt it. <LivePage> renders <AppHeader> and
// owns its own bottom padding, which reads `--dock-b` rather than the `pb-32`
// literal five older pages carry (see docs/ui.md's dock section).
export const metadata: Metadata = {
  title: `Live — ${BRAND.displayName}`,
  description: 'Podcast shows broadcasting right now, and live streams on Nostr.',
};

export default function Page() {
  return <LivePage />;
}
