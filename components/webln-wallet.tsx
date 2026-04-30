'use client';

// WebLN status surface for the account menu. There's no "connect" flow —
// WebLN is provided by a browser extension (Alby, Mutiny) and is auto-
// detected. The "Enable" button calls wl.enable() proactively so the first
// boost doesn't have to wait on a permission prompt.

import { useEffect, useState } from 'react';
import { hasWebln } from '@/lib/v4v/webln';
import { getErrorMessage } from '@/lib/util';

export function WeblnWallet() {
  const [detected, setDetected] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // hasWebln() reads window.webln, which is only defined client-side and
  // may attach asynchronously after the extension's content script runs.
  useEffect(() => {
    setDetected(hasWebln());
  }, []);

  async function enable() {
    setErr(null); setEnabling(true);
    try {
      await window.webln?.enable();
      setEnabled(true);
    } catch (e) {
      setErr(getErrorMessage(e, 'enable failed'));
    } finally { setEnabling(false); }
  }

  if (!detected) {
    return (
      <div className="mt-3 text-[11px] text-muted">
        Not detected. Install <a href="https://getalby.com" target="_blank" rel="noopener" className="underline hover:text-bolt">Alby</a> or another WebLN browser extension.
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="text-[11px] text-muted">WebLN extension detected.</div>
      {!enabled && (
        <button onClick={enable} disabled={enabling} className="btn-ghost disabled:opacity-30">
          {enabling ? 'Enabling…' : 'Enable for this site'}
        </button>
      )}
      {enabled && <div className="text-[11px] text-muted">Enabled for this site.</div>}
      {err && <div className="text-[11px] text-nostr/80">{err}</div>}
    </div>
  );
}
