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

export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>('dark');

  // Read storage after mount so SSR markup matches the dark default; the
  // FOUC-blocker has already painted the right colors before this hydrates.
  useEffect(() => {
    setMode(storage.theme.get());
  }, []);

  function toggle() {
    const next: ThemeMode = mode === 'light' ? 'dark' : 'light';
    storage.theme.set(next);
    applyTheme(next);
    setMode(next);
  }

  // Show the icon for the *target* state — sun = "tap to go light",
  // moon = "tap to go dark". Matches aria-label / title.
  const goingLight = mode !== 'light';

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
