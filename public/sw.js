// Minimal service worker — exists primarily so Chrome / Edge surface the
// install prompt and the app boots in standalone mode after install.
//
// Deliberately NO precaching: Next.js emits hashed bundle URLs that change
// every build, so any stale cache would silently break the app for installed
// users. Every request goes straight to the network, exactly as it would
// without a SW. Real caching can be layered in later (workbox / serwist) if
// offline support is ever wanted.

const VERSION = 'bmb-sw-v1';

self.addEventListener('install', (event) => {
  // Activate immediately on first install — no need to wait for all tabs to
  // close since we have no caches to migrate.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Empty fetch handler: required by some browsers for installability, but
// without responding so the network handles every request normally.
self.addEventListener('fetch', () => {});
