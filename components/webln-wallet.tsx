'use client';

// WebLN status surface for the account menu. The "Enable" button calls
// wl.enable() proactively so the first boost doesn't have to wait on a
// permission prompt.
//
// Only rendered when the parent (AccountMenu) confirms `window.webln`
// is present — see the `hasWebln()` gate there. Mobile platforms and
// vanilla desktop without Alby never see this component, so the empty
// "Not detected" branch this used to carry is gone.

import { useEffect, useState } from 'react';
import { getErrorMessage } from '@/lib/util';
import { isWeblnEnabled, subscribeWebln, weblnEnable } from '@/lib/v4v/webln';

export function WeblnWallet() {
  const [enabling, setEnabling] = useState(false);
  const [enabled, setEnabled] = useState(isWeblnEnabled());
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => subscribeWebln(() => setEnabled(isWeblnEnabled())), []);

  async function enable() {
    setErr(null); setEnabling(true);
    try {
      await weblnEnable();
      // subscribeWebln will flip `enabled`; setEnabled here is redundant but
      // harmless and makes the state change feel synchronous on the click.
      setEnabled(true);
    } catch (e) {
      setErr(getErrorMessage(e, 'enable failed'));
    } finally { setEnabling(false); }
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
