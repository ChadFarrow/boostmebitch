'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { startKeyboardInsetSync } from '@/lib/keyboard-inset';
import { clearShowSelection } from '@/lib/store';
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
 * WALLET IS NOT A TAB ANY MORE. It was the only `kind: 'modal'` entry, and the
 * Queue tab took its place — so every tab is a link and the union type that
 * carried both collapsed to one shape. The wallet is still reachable from
 * `<AuthControl>` on every route that renders `<AppHeader>`, and from the boost
 * modal's own control everywhere else, which is what had to land first.
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

// Every tab is a LINK. The Wallet tab was the only `kind: 'modal'` one and it
// is gone — see the Queue entry below for why that swap needed the boost
// modal's own connect control to land first.
type Tab = {
  href: '/' | '/queue' | '/live' | '/favorites' | '/downloads';
  label: string;
  icon: React.ReactNode;
  /** Whether `pathname` belongs to this tab. `/` is exact; the rest are prefixes. */
  match: (pathname: string) => boolean;
};

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const TABS: Tab[] = [
  {
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
    // REPLACED THE WALLET TAB, and the order of the two changes mattered.
    // The wallet was reachable from the header on `/`, /live, /favorites,
    // /playlists and /downloads — and NOWHERE ELSE, because those are the only
    // routes that render <AppHeader>. This tab was the only way to reach a
    // wallet from /stream/<naddr>, /npub/<npub> and /live/<npub>, which are
    // exactly the routes a shared link lands on and where BOOST is the point —
    // and from <FullscreenPlayer>, which covers the header on every route. So
    // the boost modal grew its own wallet control FIRST; that message used to
    // point at "top right", which on those surfaces is empty space.
    href: '/queue',
    label: 'Queue',
    match: (p) => p.startsWith('/queue'),
    icon: (
      // A stack of rows with a play glyph at the head: a list that plays,
      // rather than a bare list (which reads as another favorites) or a bare
      // triangle (which reads as the transport).
      <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden {...stroke}>
        <path d="M4 7h10M4 12h10M4 17h6" />
        <path d="M17 11.2v5.6l4.5-2.8z" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
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
];

/**
 * THE LABEL IS `font-display`, NOT THE MONO THE REST OF THE APP INHERITS, and
 * the reason is arithmetic rather than taste.
 *
 * `html, body` set JetBrains Mono, so every label costs a FIXED advance per
 * character: `Downloads` and `Favorites` are nine characters and measured 56px
 * against `Home`'s 25px, inside cells that are all the same width. The gaps a
 * reader actually sees are between label EDGES, so the dock read as evenly
 * spaced on the left and crowded on the right — 49px between the first two
 * labels and 22px between the last two at 390px, and only 8px at 320px.
 *
 * Measured against the real font files at 320 / 390 / 430px:
 *
 *   mono 10px + tracking-wide (was)   widest 56px   min gap  8px @320   22px @390
 *   font-display 10px, no tracking    widest 52px   min gap 16px @320   30px @390
 *
 * `tracking-wide` goes with it: letter-spacing on a nine-character label is
 * width spent where there is least of it.
 *
 * The gaps are still not EQUAL, and they cannot be while the cells are. That is
 * deliberate — the tap area is the grid cell, and equal cells are what keeps
 * every tab over the 44px floor. Proportional columns would even the gaps and
 * put the narrowest tab under that floor at 320px.
 */
const itemClass = (current: boolean) =>
  `flex flex-col items-center justify-center gap-1 font-display text-[10px] transition ${
    current ? 'text-bolt' : 'text-muted hover:text-bone'
  }`;

export function TabBar() {
  const pathname = usePathname() ?? '/';
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
