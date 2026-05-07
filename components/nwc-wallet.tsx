'use client';

// NWC connect/disconnect surface for the account menu. Mirrors the
// SparkWallet shape: paste a nostr+walletconnect:// URI (typically from
// Alby Hub, getalby.com, or your own node), or disconnect to remove the
// stored URI from localStorage.

import { useState } from 'react';
import { hasNwc, saveNwcUri, clearNwcUri, loadNwcUri, nwcValidate } from '@/lib/v4v/nwc';
import { hasSpark, sparkDisconnect } from '@/lib/v4v/spark';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';

export function NwcWallet() {
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
    // instead of the canonical `nostr+walletconnect://`. Accept both — the
    // SDK normalizes either form.
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
        // nwcValidate is supposed to swallow its own errors and return a
        // string. If something asynchronous still escapes, surface it instead
        // of silently bouncing back to the form.
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[nwc] probe threw unexpectedly:', e);
        setErr(`Probe failed: ${msg}`);
        return;
      }
      if (probeError) {
        console.warn('[nwc] probe rejected:', probeError);
        setErr(`Couldn’t reach the wallet: ${probeError}`);
        return;
      }
      saveNwcUri(uri);
      // Sanity check the write took. If localStorage rejected it AND the
      // memory fallback failed for some reason, surface an error rather
      // than bouncing the form silently. Normally the memory fallback in
      // storage.nwcUri keeps the wallet working for this session.
      if (!hasNwc()) {
        setErr('Couldn’t persist the URI. Try reloading the page and pasting again.');
        return;
      }
      // User explicitly chose NWC — disconnect Spark if it was auto-restored
      // this session, and suppress future auto-restores on reload.
      if (hasSpark()) await sparkDisconnect();
      storage.sparkOptOut.set();
      setDraft('');
      bump();
    } finally {
      setBusy(false);
    }
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
    const ephemeral = storage.nwcUri.isEphemeral();
    return (
      <div className="mt-3 text-[11px] text-muted">
        <div>NWC connected{host ? ` · ${host}` : ''}</div>
        {ephemeral && (
          <div className="text-bolt/80 mt-1">
            Storage is restricted by your browser — you’ll need to paste this URI again after a reload.
          </div>
        )}
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
