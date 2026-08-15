'use client';

// Last-resort boundary. app/error.tsx is a ROUTE-SEGMENT boundary, so it never
// sees a throw from app/layout.tsx itself — the root layout, the fixed hero, or
// anything mounted beside <Player>. Without this file, such a throw renders
// Next's built-in "Application error: a client-side exception has occurred",
// an unstyled page with no way forward but the browser's back button.
//
// It replaces the whole document, so it must render its own <html>/<body>.
// Deliberately no imports beyond React: this is the boundary that catches
// failures in the module graph the rest of the app is built on, and a fallback
// that can itself fail to load is not a fallback. Styling is inline for the
// same reason — globals.css may be exactly what didn't load.

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ background: '#0a0a08', color: '#e8e4d9', fontFamily: 'system-ui, sans-serif', margin: 0 }}>
        <main style={{ maxWidth: 640, margin: '0 auto', padding: '80px 20px' }}>
          <h1 style={{ fontSize: 28, margin: '0 0 12px' }}>Something broke</h1>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: '#9c968a', margin: '0 0 20px' }}>
            The app failed to start. Your wallet connection, favorites and signing
            key are stored locally and are not affected.
          </p>
          {/* The digest, not the message: Next scrubs server-side errors to a
              digest in production, and it's what correlates this screen with the
              server log. */}
          {error?.digest && (
            <p style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace', color: '#9c968a', margin: '0 0 20px' }}>
              ref: {error.digest}
            </p>
          )}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              onClick={reset}
              style={{ background: '#f5c518', color: '#0a0a08', border: 0, padding: '10px 18px', fontSize: 14, cursor: 'pointer' }}
            >
              Try again
            </button>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages --
                A hard navigation is the POINT: this boundary catches failures in
                the module graph the router itself is built on, so a client-side
                <Link> transition is exactly what may not work. Importing
                next/link here would also give this fallback a dependency it
                exists to survive the failure of. */}
            <a
              href="/"
              style={{ border: '1px solid #3a382f', color: '#e8e4d9', padding: '10px 18px', fontSize: 14, textDecoration: 'none' }}
            >
              Reload the app
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
