'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { clearShowSelection } from '@/lib/store';

/**
 * The bottom tab bar — the navigation half of the dock. The mini-player
 * (`<Player>`) is the other half and sits directly above it.
 *
 * WHY THIS EXISTS. Navigation used to live in `<AppHeader>`'s right-hand
 * cluster, beside the wallet chip and the account menu, in a row that had zero
 * slack from sm: up to ~810px. Every link added there cost the wordmark
 * characters, `<PlaylistsLink>` had to hide below lg: and reappear as a hero
 * button, and the height of that row leaked into `--app-header-h`, which
 * `<EpisodeList>` pins against. Moving the destinations down here gives the
 * header one job (brand + account) and gives every route the same way around.
 *
 * GEOMETRY. The bar is `--tabbar-h` tall (globals.css) plus the bottom safe
 * area, and it is the ONLY element that pays that inset. `<Player>`'s mini-bar
 * sits at `bottom: var(--dock-b)` — the tab bar's full height — and no longer
 * carries `pb-[env(safe-area-inset-bottom)]` of its own; two elements each
 * adding the inset was the visible gap on notched phones. Anything else that
 * must clear the bottom chrome (the layout footer, the episode-page BOOST FAB,
 * `<HomePage>`'s bottom padding) reads `--dock-b`, never a literal.
 *
 * z-30, level with the mini-bar and below `<FullscreenPlayer>`'s z-50 and
 * `<ModalShell>`'s z-[60], so the expanded player and every dialog cover it
 * without a hide-on-route rule.
 *
 * TOUCH. Each item is the full `--tabbar-h` (56px) tall and a fifth (today, a
 * third) of the width wide, so it clears the 44px floor without a min-h — the
 * icon-and-label stack is centred inside the tap area, not the tap area itself.
 *
 * THE HOME TAB CLEARS THE SELECTION. The store is module-level and survives
 * a route change on purpose (see `<AppHeader>`'s wordmark for the same rule):
 * without `clearShowSelection` a tap on Search from /favorites re-opens the
 * last show the visitor had open, and the selection-to-URL mirror rewrites
 * the address bar to `?podcast=<old>`.
 *
 * ITEMS NOT YET HERE. The mockup carries five tabs; this ships three. Live
 * needs an index page — today live streams are a section of `/`, and
 * `/live/<npub>` is one stream. Wallet needs the store's wallet-modal setter
 * wired through a client component; it is a modal, not a route. Both are
 * additive: a fourth or fifth entry in `TABS` and nothing else.
 */

type Tab = {
  href: '/' | '/favorites' | '/playlists';
  label: string;
  icon: React.ReactNode;
  /** Whether `pathname` belongs to this tab. `/` is exact; the rest are prefixes. */
  match: (pathname: string) => boolean;
};

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const TABS: Tab[] = [
  {
    href: '/',
    label: 'Search',
    match: (p) => p === '/',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden {...stroke}>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
    ),
  },
  {
    href: '/favorites',
    label: 'Favorites',
    match: (p) => p.startsWith('/favorites'),
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden {...stroke}>
        <path d="M12 21s-7-4.6-9.3-9A5.2 5.2 0 0 1 12 6.6 5.2 5.2 0 0 1 21.3 12C19 16.4 12 21 12 21z" />
      </svg>
    ),
  },
  {
    href: '/playlists',
    label: 'Playlists',
    match: (p) => p.startsWith('/playlists'),
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden {...stroke}>
        <path d="M4 6h12M4 12h12M4 18h8M18 12v7l3-2" />
      </svg>
    ),
  },
];

export function TabBar() {
  const pathname = usePathname() ?? '/';

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 bg-ink/95 backdrop-blur border-t border-bone/15 pb-[env(safe-area-inset-bottom)]"
    >
      <div
        className="max-w-7xl mx-auto grid h-[var(--tabbar-h)]"
        style={{ gridTemplateColumns: `repeat(${TABS.length}, minmax(0, 1fr))` }}
      >
        {TABS.map((tab) => {
          const current = tab.match(pathname);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              // The home tab is the one that must clear the selection — see
              // the header comment. Harmless elsewhere but not needed: the
              // other routes read the store as a handoff, not a filter.
              onClick={tab.href === '/' ? clearShowSelection : undefined}
              aria-current={current ? 'page' : undefined}
              className={`flex flex-col items-center justify-center gap-1 text-[10px] tracking-wide transition ${
                current ? 'text-bolt' : 'text-muted hover:text-bone'
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
