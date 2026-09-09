'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { startKeyboardInsetSync } from '@/lib/keyboard-inset';
import { clearShowSelection, useApp } from '@/lib/store';
import { KbDebug } from './kb-debug';

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
 * adding the inset was the visible gap on notched phones. Anything else in the
 * normal flow that must clear the bottom chrome (the layout footer,
 * `<HomePage>`'s bottom padding) reads `--dock-b`, never a literal. The two
 * full-viewport overlays are the exception and still pay the inset: they cover
 * this bar rather than stacking on it.
 *
 * THE ON-SCREEN KEYBOARD, AND THE VIEWPORT IT LEAVES BEHIND.
 * `translateY(var(--kb-inset))` pushes the whole dock down by two things at
 * once: the keyboard's height while a field is focused, so the bar hides
 * behind it rather than riding the composer, and whatever iOS has left
 * `visualViewport.offsetTop` holding afterwards. `bottom: 0` is measured from
 * the LAYOUT viewport, so that leftover is the bar stranded in the middle of
 * the page after a reply. It is the identity every other moment. This
 * component mounts the one publisher of that variable; see
 * `lib/keyboard-inset.ts`.
 *
 * z-30, level with the mini-bar and below `<FullscreenPlayer>`'s z-50 and
 * `<ModalShell>`'s z-[60], so the expanded player and every dialog cover it
 * without a hide-on-route rule.
 *
 * IT IS ON EVERY ROUTE, `/live/<npub>` and `/stream/<naddr>` included, and
 * that was decided rather than inherited (2026-09-05). Those two had no
 * `<AppHeader>` by design, so this is the first navigation they carry — and it
 * is wanted, because a listener who opens a live stream from a shared link has
 * otherwise no route into the app at all. Their full-screen `z-40`
 * "connecting…" covers paint under it, which is the same answer: a cover you
 * can leave beats one you cannot. Do not add a hide list without a new
 * reason.
 *
 * TOUCH. Each item is the full `--tabbar-h` (56px) tall and a fifth (today) of
 * the width wide, so it clears the 44px floor without a min-h — the
 * icon-and-label stack is centred inside the tap area, not the tap area itself.
 * At 390px five columns are 78px each, and height is the binding dimension at
 * 56 > 44. The floor is not threatened until SEVEN tabs (390/7 = 55.7px), which
 * is the number to check against rather than re-deriving it.
 *
 * THE HOME TAB CLEARS THE SELECTION. The store is module-level and survives
 * a route change on purpose (see `<AppHeader>`'s wordmark for the same rule):
 * without `clearShowSelection` a tap on Home from /favorites re-opens the
 * last show the visitor had open, and the selection-to-URL mirror rewrites
 * the address bar to `?podcast=<old>`.
 *
 * WALLET IS A MODAL, NOT A ROUTE. It flips `walletOpen` in the store, the same
 * flag `<AuthControl>`'s balance chip flips, and `<WalletModalHost>` in the
 * root layout renders the modal — on every route, which is the whole point of
 * moving it there (see that file). Its "current" state is the modal being
 * open, so the tab lights while the sheet is up and goes quiet when it closes.
 *
 * PLAYLISTS IS NOT A TAB, deliberately. Playlists are content: the search box
 * has a Playlists lane and `/playlists` stays a linkable page, but it is not a
 * place people live.
 *
 * LIVE IS ONE, and it is the entry this comment used to say was missing. It
 * needed an index route to point at, which `/live` now is. Its arrival also
 * moved the Nostr live row OFF the home page: that row was the only way to find
 * a live broadcast, `<podcast:liveItem>` shows had no discovery surface at all,
 * and putting both behind one tab is what let the home page stop paying for a
 * relay scan on every first paint. `match` is a PREFIX, so the tab also lights
 * on `/live/<npub>` — correct, that route is a live stream, and until now
 * nothing lit there.
 */

type LinkTab = {
  kind: 'link';
  href: '/' | '/live' | '/favorites' | '/downloads';
  label: string;
  icon: React.ReactNode;
  /** Whether `pathname` belongs to this tab. `/` is exact; the rest are prefixes. */
  match: (pathname: string) => boolean;
};
type ModalTab = {
  kind: 'modal';
  label: string;
  icon: React.ReactNode;
};
type Tab = LinkTab | ModalTab;

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const TABS: Tab[] = [
  {
    kind: 'link',
    href: '/',
    label: 'Home',
    match: (p) => p === '/',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden {...stroke}>
        <path d="M3 10.5 12 3l9 7.5" />
        <path d="M5.5 9.5V20h13V9.5" />
      </svg>
    ),
  },
  {
    kind: 'link',
    href: '/live',
    label: 'Live',
    match: (p) => p.startsWith('/live'),
    icon: (
      // A broadcast glyph: a filled centre with two pairs of arcs radiating.
      // Deliberately NOT a red dot — the `● LIVE` stamp owns that colour, and a
      // tab that looks permanently on air is a lie every hour of the day.
      <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden {...stroke}>
        <circle cx="12" cy="12" r="2.25" fill="currentColor" stroke="none" />
        <path d="M8.2 8.2a5.5 5.5 0 0 0 0 7.6" />
        <path d="M15.8 8.2a5.5 5.5 0 0 1 0 7.6" />
        <path d="M5.3 5.3a10 10 0 0 0 0 13.4" />
        <path d="M18.7 5.3a10 10 0 0 1 0 13.4" />
      </svg>
    ),
  },
  {
    kind: 'link',
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
    kind: 'link',
    href: '/downloads',
    label: 'Downloads',
    match: (p) => p.startsWith('/downloads'),
    icon: (
      // An arrow into a tray. Deliberately not a cloud: the whole point of this
      // destination is that the bytes are HERE, not somewhere else.
      <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden {...stroke}>
        <path d="M12 3v10" />
        <path d="M8 10.5 12 14.5l4-4" />
        <path d="M4 16v3.5h16V16" />
      </svg>
    ),
  },
  {
    kind: 'modal',
    label: 'Wallet',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden {...stroke}>
        <rect x="3" y="6" width="18" height="13" />
        <path d="M3 10h18M16 15h2" />
      </svg>
    ),
  },
];

const itemClass = (current: boolean) =>
  `flex flex-col items-center justify-center gap-1 text-[10px] tracking-wide transition ${
    current ? 'text-bolt' : 'text-muted hover:text-bone'
  }`;

export function TabBar() {
  const pathname = usePathname() ?? '/';
  const walletOpen = useApp((s) => s.walletOpen);
  const setWalletOpen = useApp((s) => s.setWalletOpen);

  // Mounted here rather than in the layout because this is the component the
  // variable exists for, and it is on every route already.
  useEffect(() => startKeyboardInsetSync(), []);

  return (
    <>
      {/* Renders nothing without `?kbdebug=1`. Mounted here because this is the
          component whose position it reports on. */}
      <KbDebug />
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 bg-ink/95 backdrop-blur border-t border-bone/15 pb-[env(safe-area-inset-bottom)]"
        style={{ transform: 'translateY(var(--kb-inset, 0px))' }}
      >
        <div
          className="max-w-7xl mx-auto grid h-[var(--tabbar-h)]"
          style={{ gridTemplateColumns: `repeat(${TABS.length}, minmax(0, 1fr))` }}
        >
          {TABS.map((tab) => {
            if (tab.kind === 'modal') {
              return (
                <button
                  key={tab.label}
                  type="button"
                  onClick={() => setWalletOpen(true)}
                  aria-pressed={walletOpen}
                  className={itemClass(walletOpen)}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              );
            }
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
                className={itemClass(current)}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
