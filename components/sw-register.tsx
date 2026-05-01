'use client';

import { useEffect } from 'react';

// Registers /sw.js on first paint so the browser sees a service worker
// (required by Chrome's install-prompt heuristic) and the app boots in
// standalone mode after the user adds it to their home screen. The SW
// itself is a passthrough — see public/sw.js.

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    // Skip in dev so HMR isn't intercepted.
    if (process.env.NODE_ENV !== 'production') return;
    const onLoad = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Registration failures are non-fatal — the app still works without
        // PWA install support, so swallow rather than surface a toast.
      });
    };
    if (document.readyState === 'complete') onLoad();
    else window.addEventListener('load', onLoad, { once: true });
    return () => window.removeEventListener('load', onLoad);
  }, []);
  return null;
}
