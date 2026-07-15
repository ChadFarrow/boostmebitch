'use client';

// Persistent dock for the Libre wallet widget. Mounted in app/layout.tsx (like
// <Player>) so the in-page Lightning node survives route changes, wallet-modal
// closes, and — because the bmb:libre opt-in is persisted — the Google OAuth
// full-page redirect back to `/`.
//
// Ownership is inverted from a normal component: lib/v4v/libre.ts owns the
// widget's container element and lifetime (singleton `ensureLibreWidget`);
// this component only adopts the DOM node into the dock and detaches it on
// unmount. NEVER dispose from the effect cleanup — StrictMode's dev
// mount→unmount→mount would kill the freshly mounted node. Dispose lives in
// exactly one place: libreDisconnect().

import { useEffect, useRef, useState } from 'react';
import {
  ensureLibreWidget,
  getLibreContainer,
  hasLibre,
  libreConfigured,
  subscribeLibre,
} from '@/lib/v4v/libre';

export function LibreWalletHost() {
  const hostRef = useRef<HTMLDivElement>(null);
  // false during SSR/first paint; resolved in the effect so the server and
  // client render the same nothing.
  const [optedIn, setOptedIn] = useState(false);

  useEffect(() => {
    setOptedIn(hasLibre());
    return subscribeLibre(() => setOptedIn(hasLibre()));
  }, []);

  useEffect(() => {
    if (!optedIn) return;
    const el = hostRef.current;
    if (!el) return;
    let cancelled = false;
    ensureLibreWidget()
      .then((widget) => {
        if (!cancelled && !el.contains(widget)) el.appendChild(widget);
      })
      .catch(() => { /* mount failure surfaces in the wallet modal card */ });
    return () => {
      cancelled = true;
      // Detach only — the widget (and its node) lives on in the module.
      const widget = getLibreContainer();
      if (widget && el.contains(widget)) el.removeChild(widget);
    };
  }, [optedIn]);

  if (!optedIn || !libreConfigured()) return null;

  // Above the mini-player bar; above the boost modal (z-40) and fullscreen
  // player (z-50) so the widget's own approval / spending-cap prompts are
  // reachable mid-boost, below the sign-in modal (z-[60]).
  return <div ref={hostRef} className="fixed bottom-20 right-3 z-[55]" />;
}
