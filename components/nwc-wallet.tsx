'use client';

import { useState } from 'react';
import { hasNwc, saveNwcUri, clearNwcUri, loadNwcUri, nwcValidate } from '@/lib/v4v/nwc';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';

interface Props {
  mode: 'form' | 'card';
  onConnected?: () => void;
  onDisconnected?: () => void;
}

export function NwcWallet({ mode, onConnected, onDisconnected }: Props) {
  const [, setTick] = useState(0);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const identity = useApp((s) => s.identity);

  function bump() { setTick((t) => t + 1); }

  async function connect() {
    setErr(null);
    const uri = draft.trim();
    // Some wallets emit `nostr+walletconnect:` (single-slash or no slashes)
    // instead of the canonical `nostr+walletconnect://`. Accept both.
    if (!/^nostr\+walletconnect:(\/\/)?[^\s]+$/i.test(uri)) {
      setErr('URI must start with nostr+walletconnect:');
      return;
    }
    setBusy(true);
    try {
      let probeError: string | null;
      try {
        probeError = await nwcValidate(uri);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[nwc] probe threw unexpectedly:', e);
        setErr(`Probe failed: ${msg}`);
        return;
      }
      if (probeError) {
        console.warn('[nwc] probe rejected:', probeError);
        setErr(`Couldn't reach the wallet: ${probeError}`);
        return;
      }
      saveNwcUri(uri);
      if (!hasNwc()) {
        setErr('Couldn’t persist the URI. Try reloading the page and pasting again.');
        return;
      }
      setDraft('');
      bump();
      onConnected?.();
    } finally {
      setBusy(false);
    }
  }

  function disconnect() {
    clearNwcUri();
    storage.walletBalance.clear(identity?.npub);
    bump();
    onDisconnected?.();
  }

  if (mode === 'card') {
    if (!hasNwc()) return null;
    const uri = loadNwcUri() ?? '';
    let host = '';
    try { host = new URL(uri.replace('nostr+walletconnect://', 'https://')).host; } catch {}
    const ephemeral = storage.nwcUri.isEphemeral();
    return (
      <div className="space-y-2">
        {host && <div className="text-[11px] text-muted">{host}</div>}
        {ephemeral && (
          <div className="text-[11px] text-bolt/80">
            Storage is restricted — you&apos;ll need to paste this URI again after a reload.
          </div>
        )}
        <button onClick={disconnect} className="text-[11px] text-muted hover:text-nostr">
          Disconnect
        </button>
      </div>
    );
  }

  // mode === 'form'
  if (hasNwc()) return null;
  return (
    <div className="space-y-2">
      <div className="text-xs text-bone/70 leading-relaxed">
        Paste a nostr+walletconnect:// URI from any NWC-compatible wallet.
      </div>
      <input
        className="input"
        placeholder="nostr+walletconnect://…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') connect(); }}
      />
      <div className="flex gap-2">
        <button
          onClick={connect}
          disabled={!draft.trim() || busy}
          className="btn-ghost disabled:opacity-30"
        >
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
      {err && <div className="text-[11px] text-nostr/80 break-words">{err}</div>}
    </div>
  );
}
