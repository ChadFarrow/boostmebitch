'use client';

// Amber returns to this page with the request id (we set it when opening the
// nostrsigner: URL) plus the result as a query param. We post the result via
// BroadcastChannel back to the original tab and close ourselves so the user
// sees the app, not a blank tab.

import { useEffect, useState } from 'react';
import {
  AMBER_BROADCAST_CHANNEL,
  type AmberResultMessage,
} from '@/lib/nostr/amber';

// Some Amber versions append the result with an extra '?' instead of '&'
// (e.g. `?id=abc?event=xyz`). URLSearchParams treats only the first '?' as a
// delimiter, so the second pair is silently merged into the first value.
// Normalize by replacing every '?' after the leading one with '&' before
// parsing, so both shapes work.
function parseFlexibleSearch(search: string): URLSearchParams {
  if (!search) return new URLSearchParams();
  const stripped = search.replace(/^\?/, '');
  const fixed = stripped.replace(/\?/g, '&');
  return new URLSearchParams(fixed);
}

export default function AmberCallback() {
  const [status, setStatus] = useState<'pending' | 'ok' | 'noop'>('pending');

  useEffect(() => {
    const params = parseFlexibleSearch(window.location.search);
    const id = params.get('id');
    const error = params.get('error') ?? params.get('rejected');
    // Amber's web flow may return the result under different keys depending
    // on returnType / type — check all the conventional ones.
    const result =
      params.get('event') ??
      params.get('signature') ??
      params.get('result') ??
      params.get('value') ??
      undefined;

    if (!id) {
      setStatus('noop');
      return;
    }

    try {
      const channel = new BroadcastChannel(AMBER_BROADCAST_CHANNEL);
      const message: AmberResultMessage = error
        ? { id, error }
        : { id, result };
      channel.postMessage(message);
      channel.close();
      setStatus('ok');
    } catch {
      setStatus('noop');
      return;
    }

    // Brief delay so the BroadcastChannel message has time to flush before
    // the tab closes. window.close() may be ignored by the browser if this
    // tab wasn't opened by script — that's fine, we leave a friendly message.
    const t = setTimeout(() => {
      try {
        window.close();
      } catch {
        /* swallow */
      }
    }, 150);
    return () => clearTimeout(t);
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center px-6 text-center">
      <div className="card p-8 max-w-md">
        <div className="text-nostr text-2xl mb-2">◆</div>
        {status === 'pending' && (
          <p className="text-sm text-bone/80">Returning from Amber…</p>
        )}
        {status === 'ok' && (
          <>
            <p className="text-sm text-bone/80">Done. You can close this tab.</p>
            <p className="text-[11px] text-muted mt-2">
              If your browser kept this tab open, return to the original tab.
            </p>
          </>
        )}
        {status === 'noop' && (
          <p className="text-sm text-bone/80">
            No pending Amber request found. You can close this tab.
          </p>
        )}
      </div>
    </main>
  );
}
