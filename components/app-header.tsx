'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BoltIcon } from '@/components/icons';
import { AuthControl } from '@/components/auth-control';
import { NostrAuth } from '@/components/nostr-auth';
import { FavoritesLink } from '@/components/favorites-link';
import { PlaylistsLink } from '@/components/playlists-link';
import { clearShowSelection } from '@/lib/store';
import { BRAND } from '@/lib/brand';

/**
 * The app header, shared by `/`, `/favorites` and `/playlists`.
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
  //
  // THE WORDMARK IS PER-BRAND NOW, AND THE BRANDS ARE NOT THE SAME WIDTH.
  // Measured under CDP `Emulation.setDeviceMetricsOverride` (mobile: true), in
  // the real Bricolage Grotesque at the 20px this renders below sm:, signed
  // out: "Boost Me Bitch" is 141.67px and "Boost Me Buddy" is 154.03px. The
  // box is 154.03px at 390px and 151.22px at 360px — so the longer wordmark had
  // ZERO margin on one common phone width and ellipsized on the other, while
  // the shorter one cleared both. That is why the icon is `w-5` below sm:
  // rather than `w-6`: 4px, which is the whole margin. Re-measure at 360px on
  // the BUDDY brand before adding anything to this row; the bmb brand fits
  // either way and will not show you the failure.
  const wordmark = (
    <>
      <BoltIcon className="w-5 h-5 sm:w-6 sm:h-6 text-bolt shrink-0" />
      <span className="font-display text-xl sm:text-2xl truncate">{BRAND.displayName}</span>
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
            all of it standing.
            Everywhere else it is a real link, but it still has to CLEAR THE
            SELECTION, and that is not symmetry for its own sake. The store is
            module-level and survives a route change on purpose — it is what
            <FavoritesPage>'s store-then-navigate handoff runs on — so a user
            who opened one favorite has a selection standing when they come
            back here. <HomePage> never clears it on mount, so without this the
            control labelled "Go to home" re-opens the last show and the
            selection-to-URL mirror rewrites the address bar to `?podcast=<old>`
            with nothing on screen saying why. See `clearShowSelection`. */}
        {onHome ? (
          <button type="button" onClick={onHome} className={wordmarkClass} aria-label="Go to home">
            {wordmark}
          </button>
        ) : (
          <Link
            href="/"
            onClick={clearShowSelection}
            className={wordmarkClass}
            aria-label="Go to home"
          >
            {wordmark}
          </Link>
        )}
        {/* `ml-auto` rather than a `flex-1` spacer: the spacer sat between two
            gaps and cost a whole gap of width on mobile for nothing. Identical
            on desktop — an auto margin and a flex-1 spacer lay out the same
            wherever there is slack. */}
        <div className="ml-auto flex items-center gap-1 sm:gap-4 shrink-0">
          {/* The theme control is NOT here. It was, as the one bare 32px
              icon in a row of 38px bordered chips, and it read as a control
              dropped in rather than placed — a rarely-touched preference
              sitting among the primary actions. It lives in the menus now:
              <ThemeMenuLink> in <AccountMenu> (rendered by <NostrAuth>) and
              <ThemeMenuRow> in <AuthControl>'s signed-out dropdown. One state
              has neither menu — a wallet connected with no Nostr identity —
              and <AuthControl> renders the bare icon itself for exactly that
              case, because it is the component that knows.
              The two names mislead about what they draw, which is worth
              knowing before you move anything else in this row: <AuthControl>
              is the WALLET half (balance chip, connect / sign-in buttons) and
              <NostrAuth> draws <AccountMenu> as well as owning identity
              hydration. */}
          {/* lg: and up only, and the breakpoint is measured rather than a
              taste. This row has ZERO slack from sm: up to ~810px — the
              wordmark is already taking exactly what it needs — and a
              .btn-ghost carrying an uppercased word is ~140px, a peer of
              FAVORITES rather than a glyph. At 640px it took "Boost Me Bitch"
              from 169px to 31px. Below lg: the way into /playlists is the
              hero's BROWSE PLAYLISTS button instead. Full measurements, and
              the warning to re-measure on the BUDDY brand, are in
              <PlaylistsLink>. */}
          <PlaylistsLink current={pathname === '/playlists'} />
          <FavoritesLink current={pathname === '/favorites'} />
          <AuthControl />
          <NostrAuth />
        </div>
      </div>
    </header>
  );
}
