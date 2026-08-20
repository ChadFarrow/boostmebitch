'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BoltIcon } from '@/components/icons';
import { ThemeToggle } from '@/components/theme-toggle';
import { AuthControl } from '@/components/auth-control';
import { NostrAuth } from '@/components/nostr-auth';
import { FavoritesLink } from '@/components/favorites-link';

/**
 * The app header, shared by `/` and `/favorites`.
 *
 * It was inline JSX in `<HomePage>` while `/npub`, `/live` and `/stream` went
 * without a header at all, which was fine for those three: two are player
 * overlays and the third is something you read. A favorites page is neither —
 * it is a place people stay, and every affordance its empty state points at
 * (sign in, connect a wallet) lives in this cluster.
 *
 * `--app-header-h` (`app/globals.css`) is a HARD-CODED 71px derived from this
 * markup: `py-4` (32) + the tallest control (38, a `.btn-ghost`) + a 1px
 * border. `<EpisodeList>`'s show header pins against it with
 * `sm:top-[var(--app-header-h)]`. That is the real argument for one component
 * rather than a second hand-rolled header: two headers of different heights
 * breaks a sticky offset on the OTHER route, where nobody is looking. Nothing
 * added to this cluster may exceed 38px tall without updating that variable.
 *
 * `<NostrAuth>` rides along, which is not decoration — it owns identity
 * hydration and is the only caller of `hydrateFavorites` outside the sync
 * notice's retry. A favorites page without it shows a signed-in visitor stale
 * local state and never backfills it.
 */
export function AppHeader({ onHome }: { onHome?: () => void }) {
  const pathname = usePathname();

  // Identical inner markup either way. `truncate` on the wordmark is
  // load-bearing, and so is the `min-w-0` beside it. A flex item's min-width is
  // `auto`, i.e. min-content, which for this element is its widest WORD — so
  // without them "Boost Me Bitch" broke onto three lines at 390px, tripling the
  // header and pushing the show header's own `sticky top-[var(--app-header-h)]`
  // underneath it. `shrink-0` is NOT the fix: signed in with a wallet the
  // right-hand cluster is ~230px, leaving ~128px for a ~200px title, and
  // `html { overflow-x: clip }` CLIPS rather than scrolls — the account menu
  // would be silently cut off. An ellipsis is the better failure.
  // `--app-header-h` assumes this can't wrap.
  const wordmark = (
    <>
      <BoltIcon className="w-6 h-6 text-bolt shrink-0" />
      <span className="font-display text-xl sm:text-2xl truncate">Boost Me Bitch</span>
      <span className="text-[10px] text-muted uppercase tracking-widest hidden sm:inline shrink-0">
        podcasting 2.0
      </span>
    </>
  );
  const wordmarkClass = 'flex items-center gap-2 min-w-0 hover:opacity-80 transition';

  return (
    <header className="border-b border-bone/15 sticky top-0 z-20 bg-ink/90 backdrop-blur pt-[env(safe-area-inset-top)]">
      {/* `gap-1` below sm:, where it used to be `gap-2`. The wordmark needs
          142px and had 141.6 before the FAVORITES chip joined this row, so the
          chip's width had to come from somewhere or "Boost Me Bitch"
          ellipsizes at 390px — and `truncate` is all-or-nothing about it, so a
          sub-pixel shortfall eats three characters, not a hair. Between two
          items this is worth 4px; the chip gives back the rest by shedding its
          word and count below sm:. Unchanged from sm: up. */}
      <div className="max-w-7xl mx-auto px-4 py-4 flex items-center gap-1 sm:gap-4">
        {/* A button on the home page, because "home" there means clearing the
            search and the selection in place — a <Link href="/"> would leave
            all of it standing. Everywhere else there is nothing to clear and a
            real link is what the browser deserves. */}
        {onHome ? (
          <button type="button" onClick={onHome} className={wordmarkClass} aria-label="Go to home">
            {wordmark}
          </button>
        ) : (
          <Link href="/" className={wordmarkClass} aria-label="Go to home">
            {wordmark}
          </Link>
        )}
        {/* `ml-auto` rather than a `flex-1` spacer: the spacer sat between two
            gaps and cost a whole gap of width on mobile for nothing. Identical
            on desktop — an auto margin and a flex-1 spacer lay out the same
            wherever there is slack. */}
        <div className="ml-auto flex items-center gap-1 sm:gap-4 shrink-0">
          <FavoritesLink current={pathname === '/favorites'} />
          <ThemeToggle />
          <AuthControl />
          <NostrAuth />
        </div>
      </div>
    </header>
  );
}
