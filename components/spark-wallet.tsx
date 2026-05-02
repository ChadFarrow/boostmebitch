'use client';

// Spark wallet UI. Drives create-and-back-up + restore-from-Nostr flows
// (BIP-39 / NIP-44 / kind:30078) and, once the wallet is initialized,
// surfaces the balance + a deposit-invoice generator for funding.

import { useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import {
  hasSpark,
  sparkOwner,
  sparkGenerateMnemonic,
  sparkInitFromMnemonic,
  sparkDisconnect,
  sparkGetInfo,
  sparkReceiveInvoice,
  subscribeSpark,
  subscribeSparkEvents,
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
    // Drop the cached header-chip balance so it doesn't keep flashing the
    // last-known number after the wallet's gone.
    storage.walletBalance.clear(identity?.npub);
    bump();
  }

  if (ready) {
    return <ReadyPanel owner={owner} onDisconnect={disconnect} />;
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
      {/* Idle-state form below; the ready-state panel is rendered above this block. */}
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

function ReadyPanel({ owner, onDisconnect }: { owner: string | null; onDisconnect: () => void }) {
  const [balance, setBalance] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showReceive, setShowReceive] = useState(false);
  const [amountSats, setAmountSats] = useState('');
  const [generating, setGenerating] = useState(false);
  const [invoice, setInvoice] = useState<string | null>(null);
  const [feeSats, setFeeSats] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true); setErr(null);
    try {
      const info = await sparkGetInfo();
      if (info) setBalance(info.balanceSats);
    } catch (e) {
      setErr(getErrorMessage(e, 'failed to read balance'));
    } finally { setRefreshing(false); }
  }, []);

  // Real-time SDK events drive most balance updates; the schedule below
  // fills the gap when the SDK fires its `synced` event before our
  // listener attaches (which leaves the panel showing a stale 0 balance
  // after a fresh restore). Attaching the listener BEFORE the first
  // refresh closes the obvious race; the small retry schedule afterwards
  // catches the case where the SDK has more to sync after the first
  // getInfo call.
  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    const retryTimers: ReturnType<typeof setTimeout>[] = [];

    subscribeSparkEvents((e) => {
      if (e.type === 'paymentSucceeded'
        || e.type === 'claimedDeposits'
        || e.type === 'newDeposits') {
        refresh();
        // setState fns are stable; safe to call from this captured closure
        // without adding them to the effect's deps.
        setInvoice(null);
        setFeeSats(null);
        setShowReceive(false);
        setAmountSats('');
      } else if (e.type === 'synced') {
        refresh();
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unsub = fn;
      // Fire the first refresh AFTER the listener is attached so any sync
      // events that fire from this point on are seen. Then schedule a
      // couple of retries — Breez Spark's initial sync after `connect()`
      // can take a few seconds, and the cached balance in `getInfo()` is
      // often 0 until that completes. Each retry returns the SDK's
      // current cached state, so once it updates, the panel updates too.
      refresh();
      for (const delay of [2000, 5000, 12000]) {
        retryTimers.push(setTimeout(() => {
          if (!cancelled) refresh();
        }, delay));
      }
    });

    return () => {
      cancelled = true;
      for (const t of retryTimers) clearTimeout(t);
      if (unsub) unsub();
    };
  }, [refresh]);

  async function generate() {
    setGenerating(true); setErr(null); setInvoice(null); setFeeSats(null); setCopied(false);
    try {
      const amt = amountSats.trim() ? Math.max(1, Math.floor(Number(amountSats))) : undefined;
      const { invoice: inv, feeSats: fee } = await sparkReceiveInvoice({ amountSats: amt });
      setInvoice(inv);
      setFeeSats(fee);
    } catch (e) {
      setErr(getErrorMessage(e, 'failed to generate invoice'));
    } finally { setGenerating(false); }
  }

  async function copy() {
    if (!invoice) return;
    try { await navigator.clipboard.writeText(invoice); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* ignore */ }
  }

  function clearInvoice() {
    setInvoice(null);
    setFeeSats(null);
    setAmountSats('');
    setShowReceive(false);
  }

  return (
    <div className="mt-3 space-y-2 text-[11px]">
      <div className="flex items-baseline gap-3">
        <span className="text-muted">Spark wallet ready{owner ? ` · ${owner.slice(0, 8)}…` : ''}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-bone text-base font-mono">
          {balance == null ? '—' : balance.toLocaleString()}
        </span>
        <span className="text-muted">sats</span>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="text-muted hover:text-bolt ml-2 disabled:opacity-30"
          title="Re-read balance from the SDK"
        >
          {refreshing ? '…' : '↻'}
        </button>
      </div>

      {!showReceive && !invoice && (
        <div className="flex gap-2">
          <button onClick={() => setShowReceive(true)} className="btn-ghost">Receive</button>
          <button onClick={onDisconnect} className="text-muted hover:text-nostr">disconnect</button>
        </div>
      )}

      {showReceive && !invoice && (
        <div className="space-y-2">
          <div className="text-muted">
            Pay this invoice from any Lightning wallet to fund your Spark wallet.
            Leave amount blank for a zero-amount invoice (sender chooses).
          </div>
          <div className="flex gap-2">
            <input
              className="input"
              type="number"
              min={1}
              placeholder="amount in sats (optional)"
              value={amountSats}
              onChange={(e) => setAmountSats(e.target.value)}
            />
            <button
              onClick={generate}
              disabled={generating}
              className="btn-bolt disabled:opacity-30"
            >
              {generating ? 'Generating…' : 'Generate'}
            </button>
          </div>
          <button onClick={() => setShowReceive(false)} className="text-muted hover:text-nostr">cancel</button>
        </div>
      )}

      {invoice && (
        <div className="space-y-2">
          <div className="text-muted">
            Scan with another Lightning wallet, or copy the BOLT11 below.
            Balance updates the moment Spark claims the deposit.
            {feeSats != null && feeSats > 0 ? ` Spark settle fee: ${feeSats.toLocaleString()} sats.` : ''}
          </div>
          <div className="flex justify-center bg-bone p-3">
            {/* `bone` background ensures full QR contrast regardless of dark
                mode; `imageSettings` left unset so no logo overlays the data
                modules (some wallets choke on heavy logos). */}
            <QRCodeSVG
              value={`lightning:${invoice}`}
              size={200}
              level="M"
              fgColor="#0a0a08"
              bgColor="#f5f1e8"
            />
          </div>
          <code className="block card p-2 text-[10px] leading-snug break-all select-all">
            {invoice}
          </code>
          <div className="flex gap-2">
            <button onClick={copy} className="btn-ghost">{copied ? 'Copied' : 'Copy'}</button>
            <button onClick={clearInvoice} className="text-muted hover:text-nostr">done</button>
          </div>
        </div>
      )}

      {err && <div className="text-nostr/80">{err}</div>}
    </div>
  );
}
