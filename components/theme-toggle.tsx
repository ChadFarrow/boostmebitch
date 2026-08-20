'use client';

import { useEffect, useState } from 'react';
import { storage, type ThemeMode } from '@/lib/storage';
import { MoonIcon, SunIcon } from './icons';

// Pub/sub mirrors the shape of subscribeNwc / subscribeSpark so other
// components can react to theme flips without prop-drilling. The current
// app doesn't use it yet, but exposing it keeps the API parallel to the
// other client-state surfaces.
const listeners = new Set<(m: ThemeMode) => void>();
export function subscribeTheme(fn: (m: ThemeMode) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// The FOUC-blocker in app/layout.tsx already sets data-theme on first paint.
// applyTheme runs every subsequent toggle: flip the attribute, sync the iOS
// status-bar tint via <meta name="theme-color">, fan out to listeners.
function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  if (mode === 'light') root.dataset.theme = 'light';
  else delete root.dataset.theme;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', mode === 'light' ? '#fdfaf3' : '#0a0a08');

  listeners.forEach((fn) => fn(mode));
}

/**
 * Shared by every form of the control below.
 *
 * It SUBSCRIBES rather than only seeding from storage, which is what the
 * pub/sub above was built for and had no caller for until the control gained a
 * second home. More than one form can be mounted at once — the account menu's
 * row and the bare header fallback — and without the subscription the one that
 * was not pressed keeps rendering the old icon and the old word, so the menu
 * offers "light mode" on a page that is already light.
 *
 * `toggle` does not `setMode`: `applyTheme` fans out to the listeners and this
 * hook is one of them, so the state arrives the same way it would from any
 * other instance. One path in, no chance of the two disagreeing.
 */
function useThemeMode() {
  const [mode, setMode] = useState<ThemeMode>('dark');

  // Read storage after mount so SSR markup matches the dark default; the
  // FOUC-blocker has already painted the right colors before this hydrates.
  useEffect(() => {
    setMode(storage.theme.get());
    return subscribeTheme(setMode);
  }, []);

  return {
    // Show the TARGET state — sun = "tap to go light", moon = "tap to go
    // dark". Every label below reads off this one boolean.
    goingLight: mode !== 'light',
    toggle() {
      const next: ThemeMode = mode === 'light' ? 'dark' : 'light';
      storage.theme.set(next);
      applyTheme(next);
    },
  };
}

/**
 * The bare icon form.
 *
 * **No longer in the page header.** It lives in the account menu now — a
 * preference among a row of primary actions was both the wrong hierarchy and
 * the wrong shape, being the one 32px bare icon in a row of 38px bordered
 * chips. This form survives for the ONE state that has no menu to hold it: a
 * wallet connected with no Nostr identity, where `<AuthControl>` renders a
 * direct "Sign in" button instead of a dropdown and `<AccountMenu>` does not
 * exist. Moving a control into a menu is only an improvement if the menu is
 * always there.
 */
export function ThemeToggle() {
  const { goingLight, toggle } = useThemeMode();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={goingLight ? 'Switch to light mode' : 'Switch to dark mode'}
      title={goingLight ? 'Light mode' : 'Dark mode'}
      className="p-2 text-bone hover:text-bolt transition"
    >
      {goingLight ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

/**
 * The full-width menu row, for `<AuthControl>`'s signed-out sign-in dropdown.
 *
 * Matches that menu's item geometry exactly, including the `w-4` centred glyph
 * column — ◆ / ◉ / ⚡ have different advance widths, so a row that skips it
 * starts its label at a different x than the three above it.
 *
 * It is in the SIGNED-OUT menu and not only the account menu because favorites,
 * search and playback all work signed out. Hosting a preference only where an
 * identity exists would take the control away from every visitor who has not
 * signed in — the same reason `<FavoritesLink>` is not gated on `identity`.
 */
export function ThemeMenuRow({ onDone }: { onDone?: () => void }) {
  const { goingLight, toggle } = useThemeMode();
  return (
    <button
      role="menuitem"
      type="button"
      onClick={() => { toggle(); onDone?.(); }}
      className="w-full text-left px-3 py-2 rounded hover:bg-bone/5 transition flex items-start gap-2 text-sm"
    >
      <span className="text-bone w-4 shrink-0 text-center leading-5">
        {goingLight ? <SunIcon className="w-4 h-4 inline-block" /> : <MoonIcon className="w-4 h-4 inline-block" />}
      </span>
      <span className="flex flex-col">
        <span>{goingLight ? 'Light mode' : 'Dark mode'}</span>
        <span className="text-[11px] text-muted">
          {goingLight ? 'Switch to the bone palette' : 'Switch back to the dark palette'}
        </span>
      </span>
    </button>
  );
}

/**
 * The compact text form, for `<AccountMenu>`'s footer beside "sign out".
 *
 * Deliberately not the row above: that footer is a strip of small muted text
 * links, and a full-width two-line row there would read as the menu's primary
 * action rather than as its least consequential one.
 */
export function ThemeMenuLink() {
  const { goingLight, toggle } = useThemeMode();
  return (
    <button
      type="button"
      onClick={toggle}
      className="text-[11px] text-muted hover:text-bolt transition flex items-center gap-1.5"
    >
      {goingLight ? <SunIcon className="w-3.5 h-3.5" /> : <MoonIcon className="w-3.5 h-3.5" />}
      {goingLight ? 'light mode' : 'dark mode'}
    </button>
  );
}
