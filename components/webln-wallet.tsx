'use client';

import { useEffect, useState } from 'react';
import { getErrorMessage } from '@/lib/util';
import { isWeblnEnabled, subscribeWebln, weblnDisable, weblnEnable } from '@/lib/v4v/webln';

interface Props {
  mode: 'form' | 'card';
  onConnected?: () => void;
  onDisconnected?: () => void;
}

export function WeblnWallet({ mode, onConnected, onDisconnected }: Props) {
  const [enabling, setEnabling] = useState(false);
  const [enabled, setEnabled] = useState(isWeblnEnabled());
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => subscribeWebln(() => setEnabled(isWeblnEnabled())), []);

  async function enable() {
    setErr(null); setEnabling(true);
    try {
      await weblnEnable();
      setEnabled(true);
      onConnected?.();
    } catch (e) {
      setErr(getErrorMessage(e, 'enable failed'));
    } finally { setEnabling(false); }
  }

  function disconnect() {
    weblnDisable();
    onDisconnected?.();
  }

  if (mode === 'card') {
    if (!enabled) return null;
    return (
      <div className="space-y-2">
        <div className="text-[11px] text-muted">WebLN enabled for this site.</div>
        <button onClick={disconnect} className="text-[11px] text-muted hover:text-nostr">
          Disconnect
        </button>
      </div>
    );
  }

  // mode === 'form'
  if (enabled) return null;
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-muted">WebLN extension detected.</div>
      <button onClick={enable} disabled={enabling} className="btn-ghost disabled:opacity-30">
        {enabling ? 'Enabling…' : 'Enable for this site'}
      </button>
      {err && <div className="text-[11px] text-nostr/80">{err}</div>}
    </div>
  );
}
