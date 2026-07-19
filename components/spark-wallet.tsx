'use client';

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
// Lazy-loaded (reached only through the wallet modal's Spark tab) so
// qrcode.react stays out of the initial bundle.
const QRCodeSVG = dynamic(() => import('qrcode.react').then((m) => m.QRCodeSVG), { ssr: false });
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
  subscribeSparkEvents,
} from '@/lib/v4v/spark';
import {
  fetchEncryptedMnemonic,
  publishEncryptedMnemonic,
} from '@/lib/nostr';
import { getErrorMessage } from '@/lib/util';

type InternalMode = 'idle' | 'creating' | 'restoring' | 'busy';

interface Props {
  mode: 'form' | 'card';
  onConnected?: () => void;
  onDisconnected?: () => void;
}

export function SparkWallet({ mode, onConnected, onDisconnected }: Props) {
  const identity = useApp((s) => s.identity);
  const [internalMode, setInternalMode] = useState<InternalMode>('idle');
  const [draftMnemonic, setDraftMnemonic] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pasteSeed, setPasteSeed] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const owner = sparkOwner();

  async function startCreate() {
    setErr(null);
    if (!identity) { setErr('Sign in with Nostr first — backups need your pubkey.'); return; }
    setInternalMode('busy');
    try {
      // Replaceable kind:30078 — creating a new wallet overwrites any existing backup.
      // Force the user to acknowledge before destroying the old one.
      const existing = await fetchEncryptedMnemonic(identity).catch(() => null);
      if (existing) {
        const ok = window.confirm(
          'A Spark wallet backup already exists on your relays.\n\n' +
          'Creating a new wallet will OVERWRITE that backup. The old wallet ' +
          'will be unrecoverable unless you wrote its seed phrase down.\n\n' +
          'Continue and overwrite?'
        );
        if (!ok) { setInternalMode('idle'); return; }
      }
      const m = await sparkGenerateMnemonic();
      setDraftMnemonic(m);
      setConfirmed(false);
      setInternalMode('creating');
    } catch (e) {
      setErr(getErrorMessage(e, 'failed to generate mnemonic'));
      setInternalMode('idle');
    }
  }

  async function confirmCreate() {
    if (!identity || !draftMnemonic) return;
    setInternalMode('busy'); setErr(null);
    try {
      storage.sparkOptOut.clear();
      await publishEncryptedMnemonic(identity, draftMnemonic);
      await sparkInitFromMnemonic({ mnemonic: draftMnemonic, ownerPubkey: identity.pubkey });
      setDraftMnemonic(null);
      setConfirmed(false);
      setInternalMode('idle');
      onConnected?.();
    } catch (e) {
      setErr(getErrorMessage(e, 'failed to back up mnemonic'));
      setInternalMode('creating');
    }
  }

  function cancelCreate() {
    setDraftMnemonic(null);
    setConfirmed(false);
    setInternalMode('idle');
    setErr(null);
  }

  async function restore() {
    setErr(null);
    if (!identity) { setErr('Sign in with Nostr first — restore reads from your relays.'); return; }
    setInternalMode('restoring');
    try {
      storage.sparkOptOut.clear();
      const m = await fetchEncryptedMnemonic(identity);
      if (!m) {
        setErr('No backup found on your write relays.');
        setInternalMode('idle');
        return;
      }
      await sparkInitFromMnemonic({ mnemonic: m, ownerPubkey: identity.pubkey });
      setInternalMode('idle');
      onConnected?.();
    } catch (e) {
      setErr(getErrorMessage(e, 'failed to restore wallet'));
      setInternalMode('idle');
    }
  }

  // Paste an existing seed (e.g. the user's Primal wallet) to share its balance.
  async function connectPasted() {
    setErr(null);
    if (!identity) { setErr('Sign in with Nostr first — backups need your pubkey.'); return; }
    const trimmed = pasteSeed.trim().replace(/\s+/g, ' ');
    const words = trimmed ? trimmed.split(' ') : [];
    if (words.length !== 12 && words.length !== 24) {
      setErr('Seed must be 12 or 24 words.');
      return;
    }
    setInternalMode('busy');
    try {
      // kind:30078 is replaceable — only confirm an overwrite when a DIFFERENT
      // wallet is already backed up. Re-pasting the same seed is harmless.
      const existing = await fetchEncryptedMnemonic(identity).catch(() => null);
      if (existing && existing.trim().replace(/\s+/g, ' ') !== trimmed) {
        const ok = window.confirm(
          'A different Spark wallet backup already exists on your relays.\n\n' +
          'Connecting this seed will OVERWRITE that backup. The old wallet ' +
          'will be unrecoverable unless you wrote its seed phrase down.\n\n' +
          'Continue and overwrite?'
        );
        if (!ok) { setInternalMode('idle'); return; }
      }
      storage.sparkOptOut.clear();
      await sparkInitFromMnemonic({ mnemonic: trimmed, ownerPubkey: identity.pubkey });
      // Back up so silent auto-restore works on the next load. Non-fatal.
      await publishEncryptedMnemonic(identity, trimmed).catch(() => {});
      setPasteSeed('');
      setInternalMode('idle');
      onConnected?.();
    } catch (e) {
      setErr(getErrorMessage(e, 'failed to connect wallet'));
      setInternalMode('idle');
    }
  }

  async function disconnect() {
    await sparkDisconnect();
    storage.sparkOptOut.set();
    storage.walletBalance.clear(identity?.npub);
    onDisconnected?.();
  }

  if (mode === 'card') {
    if (!hasSpark()) return null;
    return <ReadyPanel owner={owner} onDisconnect={disconnect} />;
  }

  // mode === 'form'
  if (hasSpark()) return null;

  if (internalMode === 'creating' && draftMnemonic) {
    return (
      <div className="space-y-2">
        <div className="text-[11px] uppercase tracking-widest text-bolt">
          Write this down — it&apos;s the only way to recover this wallet outside Nostr.
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
    <div className="space-y-2">
      <div className="text-xs text-bone/70 leading-relaxed">
        Self-custodial wallet. Mnemonic is NIP-44 encrypted to your pubkey and stored on your write relays.
      </div>
      <div className="space-y-2">
        <div className="text-xs text-bone/70 leading-relaxed">
          Paste an existing 12- or 24-word seed (e.g. Primal, Blitz, or any Spark wallet) to share its balance.
        </div>
        <textarea
          className="input w-full h-16 resize-none"
          placeholder="word1 word2 word3 …"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={pasteSeed}
          onChange={(e) => setPasteSeed(e.target.value)}
        />
        <button
          onClick={connectPasted}
          disabled={internalMode === 'busy' || !identity || !pasteSeed.trim()}
          className="btn-bolt disabled:opacity-30"
        >
          {internalMode === 'busy' ? 'Connecting…' : 'Connect'}
        </button>
      </div>
      <div className="flex gap-2 flex-wrap pt-1 border-t border-line">
        <button
          onClick={startCreate}
          disabled={internalMode === 'busy' || !identity}
          className="btn-ghost disabled:opacity-30"
        >
          Create new
        </button>
        <button
          onClick={restore}
          disabled={internalMode === 'restoring' || internalMode === 'busy' || !identity}
          className="btn-ghost disabled:opacity-30"
        >
          {internalMode === 'restoring' ? 'Restoring…' : 'Restore from Nostr'}
        </button>
      </div>
      {!identity && (
        <div className="text-[11px] text-muted">Sign in with Nostr to connect, create, or restore.</div>
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

  // Real-time SDK events drive most balance updates; the schedule below fills
  // the gap when the SDK fires `synced` before our listener attaches.
  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    const retryTimers: ReturnType<typeof setTimeout>[] = [];

    subscribeSparkEvents((e) => {
      if (e.type === 'paymentSucceeded'
        || e.type === 'claimedDeposits'
        || e.type === 'newDeposits') {
        refresh();
        setInvoice(null);
        setFeeSats(null);
        setShowReceive(false);
        setAmountSats('');
      } else if (e.type === 'synced') {
        refresh();
      }
    }).then((fn) => {
      if (cancelled) { fn(); return; }
      unsub = fn;
      refresh();
      for (const delay of [2000, 5000, 12000]) {
        retryTimers.push(setTimeout(() => { if (!cancelled) refresh(); }, delay));
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
    <div className="space-y-2 text-[11px]">
      <div className="flex items-baseline gap-3">
        <span className="text-muted">Spark{owner ? ` · ${owner.slice(0, 8)}…` : ''}</span>
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
          <button onClick={onDisconnect} className="text-muted hover:text-nostr">Disconnect</button>
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
