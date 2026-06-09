'use client';

import { useState } from 'react';
import { hasNwc, saveNwcUri, clearNwcUri, loadNwcUri, nwcValidate } from '@/lib/v4v/nwc';
import { publishEncryptedNwc, deleteEncryptedNwc, fetchEncryptedNwc, getNip44 } from '@/lib/nostr';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';

interface Props {
  mode: 'form' | 'card';
  onConnected?: () => void;
  onDisconnected?: () => void;
}

// Opt-in checkbox to encrypt + back up the NWC connection string to Nostr.
// Module-scope (not nested in NwcWallet) so it keeps a stable identity across
// the parent's busy/state re-renders — a nested component would remount the
// <input> on every render.
function BackupToggle({ checked, disabled, canBackup, signedIn, onToggle }: {
  checked: boolean;
  disabled: boolean;
  canBackup: boolean;
  signedIn: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <label className={`flex items-start gap-2 text-[11px] ${canBackup ? 'text-bone/80 cursor-pointer' : 'text-muted'}`}>
      <input
        type="checkbox"
        className="mt-[2px]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <span>
        Encrypt &amp; back up this connection to Nostr
        {canBackup ? (
          <span className="block text-muted">
            Restores automatically when you sign in on another device. Removed from Nostr if you turn this off or disconnect.
          </span>
        ) : (
          <span className="block text-muted">
            {signedIn ? 'Your signer doesn’t support NIP-44 encryption.' : 'Sign in with Nostr to enable.'}
          </span>
        )}
      </span>
    </label>
  );
}

export function NwcWallet({ mode, onConnected, onDisconnected }: Props) {
  const [, setTick] = useState(0);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const identity = useApp((s) => s.identity);
  // Form-only opt-in choice (applied when the user clicks Connect). The
  // connected card reads the authoritative stored flag live instead, so an
  // auto-restore or an identity arriving async is always reflected.
  const [formBackup, setFormBackup] = useState(false);

  // Backup needs a signed-in identity AND a signer that can NIP-44 encrypt.
  const canBackup = !!identity && getNip44() !== null;

  function bump() { setTick((t) => t + 1); }

  async function restoreFromNostr() {
    if (!identity || !canBackup) return;
    setBusy(true);
    setErr(null);
    try {
      const uri = await fetchEncryptedNwc(identity);
      if (!uri) {
        setErr('No backup found on Nostr for this account.');
        return;
      }
      saveNwcUri(uri);
      storage.nwcBackup.set(identity.npub);
      bump();
      onConnected?.();
    } catch (e) {
      setErr(`Restore failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  }

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
      // Best-effort encrypted backup to Nostr when the user opted in. A
      // failure here doesn't undo the (working) local connection.
      if (formBackup && canBackup && identity) {
        try {
          await publishEncryptedNwc(identity, uri);
          storage.nwcBackup.set(identity.npub);
        } catch (e) {
          setErr(`Connected, but Nostr backup failed: ${e instanceof Error ? e.message : 'unknown error'}`);
        }
      }
      setDraft('');
      bump();
      onConnected?.();
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    // Tombstone the Nostr backup (if any) FIRST and await it. A fire-and-
    // forget delete that fails would leave the encrypted credential on relays,
    // and the next login (no local URI) would auto-restore the very connection
    // the user just disconnected. On failure we keep the local connection so
    // the user can retry rather than silently resurrecting it later.
    if (identity && storage.nwcBackup.get(identity.npub) && getNip44()) {
      setBusy(true);
      setErr(null);
      try {
        await deleteEncryptedNwc(identity);
        storage.nwcBackup.clear(identity.npub);
      } catch (e) {
        setErr(`Couldn’t remove the Nostr backup: ${e instanceof Error ? e.message : 'unknown error'}. Tap Disconnect again to retry.`);
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    clearNwcUri();
    storage.walletBalance.clear(identity?.npub);
    bump();
    onDisconnected?.();
  }

  async function toggleBackup(next: boolean) {
    if (!canBackup || !identity || busy) return;
    const uri = loadNwcUri();
    if (next && !uri) return;
    setBusy(true);
    setErr(null);
    try {
      if (next) {
        await publishEncryptedNwc(identity, uri!);
        storage.nwcBackup.set(identity.npub);
      } else {
        await deleteEncryptedNwc(identity);
        storage.nwcBackup.clear(identity.npub);
      }
    } catch (e) {
      setErr(`Backup ${next ? 'enable' : 'disable'} failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      // Re-render so the card's live read of storage.nwcBackup reflects the
      // change (success) or stays put (failure).
      setBusy(false);
    }
  }

  if (mode === 'card') {
    if (!hasNwc()) return null;
    const uri = loadNwcUri() ?? '';
    let host = '';
    try { host = new URL(uri.replace('nostr+walletconnect://', 'https://')).host; } catch {}
    const ephemeral = storage.nwcUri.isEphemeral();
    // Authoritative, live backup state for the connected account.
    const cardBackup = !!identity && storage.nwcBackup.get(identity.npub);
    return (
      <div className="space-y-2">
        {host && <div className="text-[11px] text-muted">{host}</div>}
        {ephemeral && (
          <div className="text-[11px] text-bolt/80">
            Storage is restricted — you&apos;ll need to paste this URI again after a reload.
          </div>
        )}
        <BackupToggle
          checked={cardBackup}
          disabled={!canBackup || busy}
          canBackup={canBackup}
          signedIn={!!identity}
          onToggle={toggleBackup}
        />
        {err && <div className="text-[11px] text-nostr/80 break-words">{err}</div>}
        <button
          onClick={disconnect}
          disabled={busy}
          className="text-[11px] text-muted hover:text-nostr disabled:opacity-40"
        >
          {busy ? 'Working…' : 'Disconnect'}
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
      <BackupToggle
        checked={formBackup}
        disabled={!canBackup || busy}
        canBackup={canBackup}
        signedIn={!!identity}
        onToggle={setFormBackup}
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
      {canBackup && (
        <div className="border-t border-bone/15 pt-2">
          <button
            onClick={restoreFromNostr}
            disabled={busy}
            className="text-[11px] text-muted hover:text-bone disabled:opacity-40"
          >
            {busy ? 'Restoring…' : '↩ Restore from Nostr backup'}
          </button>
        </div>
      )}
      {err && <div className="text-[11px] text-nostr/80 break-words">{err}</div>}
    </div>
  );
}
