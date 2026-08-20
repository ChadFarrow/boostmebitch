'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/store';

/**
 * The header's way into `/favorites`.
 *
 * **Never gated on `identity`.** Favorites work signed out — they are local
 * until a Nostr key exists to sync them under — so gating this on a session
 * would strand a signed-out user with forty saved albums and no way to reach
 * them. That is also why the account menu is the wrong home for it: that menu
 * is Nostr-only and does not exist for a signed-out visitor.
 *
 * **The count is behind a `mounted` flag, and the flag is the whole reason
 * this is its own component.** `lib/store.ts` reads `favorites` from
 * localStorage at MODULE scope, so it is `{}` on the server and already
 * populated on the client before React hydrates. Rendering the number on the
 * first client pass is a mismatch, and this sits in the header — React 19
 * responds to a mismatch by throwing the subtree away and rebuilding it, which
 * is what `<HomePage>` used to carry its own `mounted` gate for. Keeping the
 * hazard inside one small component means no layout decision depends on it.
 *
 * Height must stay within a `.btn-ghost`'s 38px: `--app-header-h` is hard-coded
 * to 71px against this cluster (see `<AppHeader>`).
 */
export function FavoritesLink({ current }: { current?: boolean }) {
  const favorites = useApp((s) => s.favorites);
  const favoriteEpisodes = useApp((s) => s.favoriteEpisodes);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Feeds and items are two maps and one library — the header states the total,
  // for the same reason the old panel heading did: an items-only user reading a
  // feeds-only count sees "0" above a full list.
  const count = mounted ? Object.keys(favorites).length + Object.keys(favoriteEpisodes).length : 0;
  const any = count > 0;

  return (
    <Link
      href="/favorites"
      aria-current={current ? 'page' : undefined}
      aria-label={mounted ? `Favorites (${count})` : 'Favorites'}
      title="Favorites"
      // Same magenta-when-populated vocabulary as <FavHeart>, so the chip reads
      // as the same feature rather than a second one. The word collapses below
      // sm: — the header is already tight enough at 390px that the wordmark
      // truncates — and the aria-label above carries the meaning either way.
      // `px-2` on mobile rather than `.btn-compact`'s `px-2.5`, and it is
      // measured: the wordmark needs 142px and the header offered it 141.6
      // before this chip existed, so every pixel this takes comes straight off
      // the brand name. At px-2 it lands back at ~141.7 and "Boost Me Bitch"
      // still reads whole at 390px. Unchanged from sm: up.
      className={`btn-ghost px-2 gap-1.5 sm:px-4 sm:gap-2 ${
        any ? 'border-nostr/70 text-nostr' : ''
      } ${current ? 'bg-bone/5' : ''}`}
    >
      <span className="text-base leading-none">{any ? '♥' : '♡'}</span>
      <span className="hidden sm:inline">Favorites</span>
      {/* Suppressed at zero rather than showing "0": the empty state is the
          page's job to explain, and a zero in the chrome reads as a broken
          badge. Also suppressed pre-mount, which is the same claim honestly —
          nothing is known yet.
          The word AND the count go below sm:, leaving a bare glyph — measured,
          not guessed: at 390px the full chip is ~66px and the wordmark needs
          142px in a box that offers 124, so keeping it would spend the brand
          name to show a number. The filled magenta heart already says "you
          have some", the aria-label above still says how many, and this is the
          same trade <FavHeart>'s 'sm' chip makes one row down. */}
      {any && <span className="hidden sm:inline font-mono text-[11px] opacity-70">{count}</span>}
    </Link>
  );
}
