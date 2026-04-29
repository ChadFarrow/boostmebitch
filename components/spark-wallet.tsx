'use client';

// Spark wallet UI — minimum surface to drive the create-and-back-up and
// restore-from-Nostr flows. The Breez Spark SDK itself is still stubbed
// (lib/v4v/spark.ts), so payments will throw "Spark wallet not initialized"
// until that's wired. This component exercises everything around it:
// BIP-39 generation, NIP-44 encrypt-to-self, kind:30078 publish, and
// fetch-on-restore.

import { useEffect, useState } from 'react';
import { useApp } from '@/lib/store';
import {
  hasSpark,
  sparkOwner,
  sparkGenerateMnemonic,
  sparkInitFromMnemonic,
  sparkDisconnect,
  subscribeSpark,
} from '@/lib/v4v/spark';
import {
  fetchEncryptedMnemonic,
  publishEncryptedMnemonic,
} from '@/lib/nostr';
import { getErrorMessage } from '@/lib/util';

type Mode = 'idle' | 'creating' | 'restoring' | 'busy';

interface Props {
  onReady?: () => void;
}

export function SparkWallet({ onReady }: Props) {
  const identity = useApp((s) => s.identity);
  const [, setTick] = useState(0);
  const [mode, setMode] = useState<Mode>('idle');
  const [draftMnemonic, setDraftMnemonic] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ready = hasSpark();
  const owner = sparkOwner();

  function bump() { setTick((t) => t + 1); }

  // Re-render when an outside actor (e.g. auto-restore in loadProfile) flips
  // the wallet state after this component has already mounted.
  useEffect(() => subscribeSpark(bump), []);

  async function startCreate() {
    setErr(null);
    if (!identity) { setErr('Sign in with Nostr first — backups need your pubkey.'); return; }
    setMode('busy');
    try {
      // Replaceable kind:30078 with d-tag boostmebitch:wallet:spark — creating
      // a new wallet would overwrite any existing backup on relays. If there
      // is one, force the user to acknowledge before destroying it.
      const existing = await fetchEncryptedMnemonic(identity).catch(() => null);
      if (existing) {
        const ok = window.confirm(
          'A Spark wallet backup already exists on your relays.\n\n' +
          'Creating a new wallet will OVERWRITE that backup. The old wallet ' +
          'will be unrecoverable unless you wrote its seed phrase down.\n\n' +
          'Continue and overwrite?'
        );
        if (!ok) { setMode('idle'); return; }
      }
      const m = await sparkGenerateMnemonic();
      setDraftMnemonic(m);
      setConfirmed(false);
      setMode('creating');
    } catch (e) {
      setErr(getErrorMessage(e, 'failed to generate mnemonic'));
      setMode('idle');
    }
  }

  async function confirmCreate() {
    if (!identity || !draftMnemonic) return;
    setMode('busy'); setErr(null);
    try {
      await publishEncryptedMnemonic(identity, draftMnemonic);
      await sparkInitFromMnemonic({ mnemonic: draftMnemonic, ownerPubkey: identity.pubkey });
      setDraftMnemonic(null);
      setConfirmed(false);
      setMode('idle');
      bump();
      onReady?.();
    } catch (e) {
      setErr(getErrorMessage(e, 'failed to back up mnemonic'));
      setMode('creating');
    }
  }

  function cancelCreate() {
    setDraftMnemonic(null);
    setConfirmed(false);
    setMode('idle');
    setErr(null);
  }

  async function restore() {
    setErr(null);
    if (!identity) { setErr('Sign in with Nostr first — restore reads from your relays.'); return; }
    setMode('restoring');
    try {
      const m = await fetchEncryptedMnemonic(identity);
      if (!m) {
        setErr('No backup found on your write relays.');
        setMode('idle');
        return;
      }
      await sparkInitFromMnemonic({ mnemonic: m, ownerPubkey: identity.pubkey });
      setMode('idle');
      bump();
      onReady?.();
    } catch (e) {
      setErr(getErrorMessage(e, 'failed to restore wallet'));
      setMode('idle');
    }
  }

  async function disconnect() {
    await sparkDisconnect();
    bump();
  }

  if (ready) {
    return (
      <div className="mt-3 text-[11px] text-muted">
        <div>Spark wallet ready{owner ? ` · ${owner.slice(0, 8)}…` : ''}</div>
        <button onClick={disconnect} className="text-muted hover:text-nostr mt-1">
          disconnect Spark
        </button>
      </div>
    );
  }

  if (mode === 'creating' && draftMnemonic) {
    return (
      <div className="mt-3 space-y-2">
        <div className="text-[11px] uppercase tracking-widest text-bolt">
          Write this down — it's the only way to recover this wallet outside Nostr.
        </div>
        <code className="block card p-3 text-xs leading-relaxed break-words select-all">
          {draftMnemonic}
        </code>
        <label className="flex items-center gap-2 text-[11px] text-muted">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          I&apos;ve written it down somewhere safe.
        </label>
        <div className="flex gap-2">
          <button
            onClick={confirmCreate}
            disabled={!confirmed}
            className="btn-bolt disabled:opacity-30"
          >
            Back up to Nostr
          </button>
          <button onClick={cancelCreate} className="btn-ghost">Cancel</button>
        </div>
        {err && <div className="text-[11px] text-nostr/80">{err}</div>}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="text-[11px] text-muted">
        Self-custodial wallet. Mnemonic is NIP-44 encrypted to your pubkey and stored on your write relays.
      </div>
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={startCreate}
          disabled={mode === 'busy' || !identity}
          className="btn-ghost disabled:opacity-30"
        >
          Create new
        </button>
        <button
          onClick={restore}
          disabled={mode === 'restoring' || mode === 'busy' || !identity}
          className="btn-ghost disabled:opacity-30"
        >
          {mode === 'restoring' ? 'Restoring…' : 'Restore from Nostr'}
        </button>
      </div>
      {!identity && (
        <div className="text-[11px] text-muted">Sign in with Nostr to create or restore.</div>
      )}
      {err && <div className="text-[11px] text-nostr/80">{err}</div>}
    </div>
  );
}
