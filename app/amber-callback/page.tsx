'use client';

// Amber returns to this page with the request id (we set it when opening the
// nostrsigner: URL) plus the result as a query param. We post the result back
// to the originating tab via three parallel channels so at least one survives
// whatever browser/Android/Amber-version combo the user is on:
//
//   1. BroadcastChannel — same-origin pubsub across tabs in the same browser
//   2. window.opener.postMessage — direct reply to the popup's parent
//   3. localStorage write — fires a cross-tab `storage` event everyone listens for
//
// Then we close the tab (which the browser may ignore if the tab wasn't
// opened by script — that's fine, we leave a friendly status message).

import { useEffect, useState } from 'react';
import {
  AMBER_BROADCAST_CHANNEL,
  AMBER_STORAGE_KEY_PREFIX,
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
  const [status, setStatus] = useState<'pending' | 'ok' | 'noop' | 'error'>('pending');
  const [debug, setDebug] = useState<string>('');

  useEffect(() => {
    // Amber may put the result in either ?search or #hash depending on how the
    // OS dispatched the URL — try both.
    const fromSearch = parseFlexibleSearch(window.location.search);
    const fromHash = parseFlexibleSearch(window.location.hash.replace(/^#/, '?'));
    const get = (k: string) => fromSearch.get(k) ?? fromHash.get(k);

    const id = get('id');
    const error = get('error') ?? get('rejected');
    // Amber's web flow may return the result under different keys depending
    // on returnType / type — check all the conventional ones.
    const result =
      get('event') ??
      get('signature') ??
      get('result') ??
      get('value') ??
      undefined;

    if (!id) {
      setDebug(`No id in URL. search=${window.location.search} hash=${window.location.hash}`);
      setStatus('noop');
      return;
    }

    const message: AmberResultMessage = error
      ? { id, error, source: 'bmb:amber' }
      : { id, result, source: 'bmb:amber' };

    let posted = 0;

    // 1. BroadcastChannel
    try {
      const channel = new BroadcastChannel(AMBER_BROADCAST_CHANNEL);
      channel.postMessage(message);
      channel.close();
      posted++;
    } catch (e) {
      setDebug((d) => d + `\nBC failed: ${(e as Error).message}`);
    }

    // 2. postMessage to opener
    try {
      window.opener?.postMessage(message, window.location.origin);
      posted++;
    } catch (e) {
      setDebug((d) => d + `\npostMessage failed: ${(e as Error).message}`);
    }

    // 3. localStorage event — write then immediately remove so the same id
    //    can be reused later without leaking. Listeners read e.newValue.
    try {
      const key = `${AMBER_STORAGE_KEY_PREFIX}${id}`;
      localStorage.setItem(key, JSON.stringify(message));
      // Don't remove immediately — give the listener a beat to read e.newValue.
      // 1s is enough; if the listener is alive at all it fires synchronously
      // on setItem.
      setTimeout(() => {
        try { localStorage.removeItem(key); } catch { /* ignore */ }
      }, 1000);
      posted++;
    } catch (e) {
      setDebug((d) => d + `\nlocalStorage failed: ${(e as Error).message}`);
    }

    setStatus(posted > 0 ? 'ok' : 'error');

    // Brief delay so messages have time to flush before the tab closes.
    // window.close() may be ignored if this tab wasn't opened by script.
    const t = setTimeout(() => {
      try { window.close(); } catch { /* swallow */ }
    }, 250);
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
              If the original tab didn&apos;t pick this up, return to it and paste the result manually.
            </p>
          </>
        )}
        {status === 'error' && (
          <p className="text-sm text-bone/80">
            Couldn&apos;t deliver the result automatically. Return to the original tab and paste it manually.
          </p>
        )}
        {status === 'noop' && (
          <>
            <p className="text-sm text-bone/80">
              No pending Amber request found. You can close this tab.
            </p>
            {debug && (
              <pre className="text-[10px] text-muted mt-3 whitespace-pre-wrap text-left">{debug}</pre>
            )}
          </>
        )}
      </div>
    </main>
  );
}
