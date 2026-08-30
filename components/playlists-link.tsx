'use client';
import Link from 'next/link';

/**
 * The header's way into `/playlists`.
 *
 * **`hidden lg:inline-flex`, and the breakpoint is a measurement rather than a
 * taste — `sm:` was the obvious choice and it is wrong.** This chip is a
 * `.btn-ghost`, so `px-4` + `text-sm` + `tracking-wider` over an uppercased
 * word makes it **140.77px**, a peer of `<FavoritesLink>`'s 134.25px rather
 * than a glyph. Measured under CDP on the bmb brand, signed out, against the
 * wordmark's own `scrollWidth`/`clientWidth`:
 *
 * | width | wordmark without this chip | with it |
 * |-------|---------------------------|---------|
 * | 640px | 169 / 169                 | **31 / 169 — truncated to "B…"** |
 * | 768px | 169 / 169                 | **159 / 169 — truncated** |
 * | 820px | 169 / 169                 | 169 / 169 |
 * | 1024px| 169 / 169                 | 169 / 169 |
 *
 * The header has **zero slack** from `sm:` up to ~810px — the wordmark is
 * already taking exactly what it needs — so anything added there comes straight
 * off the brand name, and `truncate` is all-or-nothing: a shortfall eats the
 * word, not a hair. Below `sm:` it is worse still and documented in
 * `<AppHeader>`: "Boost Me Bitch" is 141.67px in a 141.6px box and "Boost Me
 * Buddy" is 154.03px in a 154.03px box.
 *
 * At `lg:` both brands clear it with room to spare — measured with the buddy
 * wordmark substituted in place, signed out, the gap between it and the
 * right-hand cluster is **352.67px at 1024px**. **Re-measure on the BUDDY brand
 * before lowering this breakpoint**: it is the longer wordmark (184px against
 * bmb's 169px at `sm:` and up) and it is the one that will show you the
 * failure.
 *
 * Below `lg:` the entry point is the hero's BROWSE PLAYLISTS button instead.
 * That is not the same control in two places: the hero button is discovery and
 * hides the moment the visitor searches, while this one is navigation and
 * persists across `/favorites`, a search, and a drilled-in show. Both are a
 * plain `<Link href="/playlists">` with no logic, so there is nothing to drift.
 *
 * Height must stay within a `.btn-ghost`'s 38px: `--app-header-h` is hard-coded
 * to 71px against this cluster (see `<AppHeader>`). Adding nothing below `lg:`
 * is also what keeps that variable, and `<EpisodeList>`'s sticky offset on the
 * other route, untouched.
 */
export function PlaylistsLink({ current }: { current?: boolean }) {
  return (
    <Link
      href="/playlists"
      aria-current={current ? 'page' : undefined}
      aria-label="Playlists"
      title="Browse Podcasting 2.0 playlists"
      className={`btn-ghost hidden lg:inline-flex gap-2 ${current ? 'bg-bone/5' : ''}`}
    >
      <span className="text-base leading-none">♫</span>
      <span>Playlists</span>
    </Link>
  );
}
