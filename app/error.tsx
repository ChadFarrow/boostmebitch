'use client';

// Route-segment error boundary. Next.js mounts this when any client component
// inside `app/page.tsx` throws during render, instead of replacing the entire
// document with the default "Application error" message. The user keeps the
// header / hero and can `Try again` to remount, or `← back to home` to clear
// whatever state (selected podcast, stale cache hit) tripped the throw.

import { useEffect } from 'react';
import { useApp } from '@/lib/store';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const setSelected = useApp((s) => s.selectPodcast);

  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[boostmebitch] route error:', error);
  }, [error]);

  return (
    <main className="min-h-screen pb-32 px-4 pt-[env(safe-area-inset-top)]">
      <div className="max-w-xl mx-auto pt-20">
        <div className="card p-5">
          <h2 className="font-display text-2xl">Something broke on this page</h2>
          <p className="text-sm text-muted mt-2">
            One of the components on this view threw while rendering. The rest
            of the app is fine — try the buttons below.
          </p>
          {error?.message && (
            <pre className="text-[11px] text-muted/80 font-mono mt-3 whitespace-pre-wrap break-words border border-bone/10 p-2">
              {error.message}
            </pre>
          )}
          <div className="flex flex-wrap gap-2 mt-4">
            <button onClick={reset} className="btn">Try again</button>
            <button
              onClick={() => { setSelected(null); reset(); }}
              className="btn-ghost"
            >
              ← back to home
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
