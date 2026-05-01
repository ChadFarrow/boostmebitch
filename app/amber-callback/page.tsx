'use client';

// Vestigial route. The active Amber flow uses same-tab dispatch + clipboard,
// so Amber should never navigate the browser here. We keep the page in case
// a stale Amber configuration still tries to use a callbackUrl — it shows a
// friendly status and lets the user copy the result by hand.

import { useEffect, useState } from 'react';

function parseFlexibleSearch(search: string): URLSearchParams {
  if (!search) return new URLSearchParams();
  const stripped = search.replace(/^\?/, '');
  const fixed = stripped.replace(/\?/g, '&');
  return new URLSearchParams(fixed);
}

export default function AmberCallback() {
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    const params = parseFlexibleSearch(window.location.search);
    const value =
      params.get('event') ??
      params.get('signature') ??
      params.get('result') ??
      params.get('value') ??
      null;
    if (value) setResult(value);
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center px-6 text-center">
      <div className="card p-8 max-w-md">
        <div className="text-nostr text-2xl mb-2">◆</div>
        <p className="text-sm text-bone/80">
          Done. Return to the original Boost Me Bitch tab.
        </p>
        {result && (
          <>
            <p className="text-[11px] text-muted mt-3">
              If sign-in didn&apos;t complete automatically, copy this and paste it into the
              &quot;Paste manually&quot; field on the original tab:
            </p>
            <pre className="text-[10px] text-bone mt-2 break-all whitespace-pre-wrap select-all bg-ink/40 p-2">
              {result}
            </pre>
          </>
        )}
      </div>
    </main>
  );
}
