'use client';

// NWC connect/disconnect surface for the account menu. Mirrors the
// SparkWallet shape: paste a nostr+walletconnect:// URI (typically from
// Alby Hub, getalby.com, or your own node), or disconnect to remove the
// stored URI from localStorage.

import { useState } from 'react';
import { hasNwc, saveNwcUri, clearNwcUri, loadNwcUri } from '@/lib/v4v/nwc';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';

export function NwcWallet() {
  const [, setTick] = useState(0);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const identity = useApp((s) => s.identity);

  function bump() { setTick((t) => t + 1); }

  function connect() {
    setErr(null);
    const uri = draft.trim();
    if (!uri.startsWith('nostr+walletconnect://')) {
      setErr('URI must start with nostr+walletconnect://');
      return;
    }
    saveNwcUri(uri);
    setDraft('');
    bump();
  }

  function disconnect() {
    clearNwcUri();
    // Drop the cached header-chip balance so it doesn't keep showing the
    // last-known number after the URI is gone.
    storage.walletBalance.clear(identity?.npub);
    bump();
  }

  if (hasNwc()) {
    const uri = loadNwcUri() ?? '';
    // Show only the wallet domain so the secret isn't visible at a glance.
    let host = '';
    try { host = new URL(uri.replace('nostr+walletconnect://', 'https://')).host; } catch {}
    return (
      <div className="mt-3 text-[11px] text-muted">
        <div>NWC connected{host ? ` · ${host}` : ''}</div>
        <button onClick={disconnect} className="text-muted hover:text-nostr mt-1">
          disconnect NWC
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="text-[11px] text-muted">
        Paste a nostr+walletconnect:// URI from Alby Hub, getalby.com, or your own node.
      </div>
      <input
        className="input"
        placeholder="nostr+walletconnect://…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') connect(); }}
      />
      <div className="flex gap-2">
        <button onClick={connect} disabled={!draft.trim()} className="btn-ghost disabled:opacity-30">
          Connect
        </button>
      </div>
      {err && <div className="text-[11px] text-nostr/80">{err}</div>}
    </div>
  );
}
