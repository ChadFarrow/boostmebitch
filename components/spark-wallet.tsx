'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useFlash } from '@/lib/use-flash';
import { useConfirm } from './confirm-dialog';
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
  sparkSeedIsActive,
  subscribeSpark,
  subscribeSparkEvents,
  sparkFailureIs,
  sparkLastFailure,
  subscribeSparkFailure,
  type SparkFailure,
} from '@/lib/v4v/spark';
import {
  fetchEncryptedMnemonicDetailed,
  publishEncryptedMnemonic,
} from '@/lib/nostr';
import { backupOverwriteVerdict, type BackupOverwrite } from '@/lib/nostr/read-trust';
import { getErrorMessage, sparkFailureCause } from '@/lib/util';

type InternalMode = 'idle' | 'creating' | 'restoring' | 'busy';

/**
 * A PASTED SEED WHOSE BACKUP REACHED NO RELAY — the one wallet this app cannot
 * open again. Nothing else persists the seed (`lib/v4v/spark.ts` holds it in
 * memory only), so after a reload the page-load restore opens whatever the
 * kind:30078 backup holds, or nothing: the user's other wallet, a wallet derived
 * from their key, or no wallet at all, and never this one. Until the full-code
 * review of 2026-11-19 that failure was a `console.warn`: the connect form is
 * gone by then (the modal flips to the card the moment Spark connects) and the
 * window closed itself, so nothing on screen ever said it.
 *
 * MODULE STATE, because the form that sees the failure and the card that must
 * say it are two `<SparkWallet>` instances, and the first has unmounted. It
 * holds a retry CLOSURE, never the seed: there is no accessor that returns the
 * words, only one that publishes them to the account that pasted them, and
 * only while that seed is still the running wallet (`isActive`). It is dropped
 * on a successful retry, on Disconnect, and on any Spark change that stops that
 * seed running — sign-out runs `sparkDisconnect()`, so that is covered too. No
 * `bmb:*` key: a seed with no backup does not outlive the tab anyway.
 */
type UnbackedWallet = { npub: string; isActive: () => boolean; backUp: () => Promise<unknown> };
let unbacked: UnbackedWallet | null = null;
const unbackedListeners = new Set<() => void>();
function setUnbacked(next: UnbackedWallet | null) {
  if (next === unbacked) return;
  unbacked = next;
  for (const fn of unbackedListeners) fn();
}
function subscribeUnbacked(fn: () => void) {
  unbackedListeners.add(fn);
  return () => { unbackedListeners.delete(fn); };
}
subscribeSpark(() => {
  if (unbacked && !unbacked.isActive()) setUnbacked(null);
});
/** The notice for THIS account's running wallet, or null. */
function useUnbackedWallet(npub: string | undefined): UnbackedWallet | null {
  const u = useSyncExternalStore(subscribeUnbacked, () => unbacked, () => null);
  return u && npub && u.npub === npub && u.isActive() ? u : null;
}

interface Props {
  mode: 'form' | 'card';
  /** `keepOpen`: the wallet connected, but the card has something to say
   *  before the window closes (a pasted seed whose backup reached no relay). */
  onConnected?: (opts?: { keepOpen?: boolean }) => void;
  onDisconnected?: () => void;
}

export function SparkWallet({ mode, onConnected, onDisconnected }: Props) {
  const identity = useApp((s) => s.identity);
  const [internalMode, setInternalMode] = useState<InternalMode>('idle');
  const [draftMnemonic, setDraftMnemonic] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pasteSeed, setPasteSeed] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [confirm, confirmEl] = useConfirm();

  const owner = sparkOwner();

  // Read what the backup coordinate holds BEFORE anything is published over it.
  // kind:30078 is replaceable, so the publish destroys the old backup, which may
  // be the only copy of a funded seed. A read that THREW or that no relay
  // reliably answered is "unknown", never "no backup": `.catch(() => null)` here
  // used to skip the warning on a flaky connection. `backupOverwriteVerdict`.
  async function overwriteVerdict(incoming?: string): Promise<BackupOverwrite> {
    if (!identity) return 'warn-unknown';
    let read: Awaited<ReturnType<typeof fetchEncryptedMnemonicDetailed>> | null;
    try {
      read = await fetchEncryptedMnemonicDetailed(identity, 'user-initiated');
    } catch {
      read = null;
    }
    return backupOverwriteVerdict(read, incoming);
  }

  async function confirmOverwrite(verdict: BackupOverwrite, action: 'Creating a new wallet' | 'Connecting this seed') {
    return confirm({
      title: 'Overwrite your Spark wallet backup?',
      body: (
        <>
          <p>
            {verdict === 'warn-unknown'
              ? 'We could not check whether a Spark wallet backup already exists on your relays. One may.'
              : 'A different Spark wallet backup already exists on your relays.'}
          </p>
          <p>
            {action} will <strong>overwrite</strong> that backup. The old wallet will be
            unrecoverable unless you wrote its seed phrase down.
          </p>
        </>
      ),
      confirmLabel: 'Overwrite backup',
      danger: true,
    });
  }

  async function startCreate() {
    setErr(null);
    if (!identity) { setErr('Sign in with Nostr first — backups need your pubkey.'); return; }
    setInternalMode('busy');
    try {
      // Replaceable kind:30078 — creating a new wallet overwrites any existing backup.
      // Force the user to acknowledge before destroying the old one, and also when
      // we could not tell whether there is one.
      const verdict = await overwriteVerdict();
      if (verdict !== 'safe') {
        const ok = await confirmOverwrite(verdict, 'Creating a new wallet');
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
      storage.sparkOptOut.clear(identity?.npub);
      await publishEncryptedMnemonic(identity, draftMnemonic);
      await sparkInitFromMnemonic({ mnemonic: draftMnemonic, ownerPubkey: identity.pubkey });
      setDraftMnemonic(null);
      setConfirmed(false);
      setInternalMode('idle');
      onConnected?.();
    } catch (e) {
      // A failed init is already on screen as <SparkFailureNotice>; say it once.
      setErr(sparkFailureIs(e) ? null : getErrorMessage(e, 'failed to back up mnemonic'));
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
      storage.sparkOptOut.clear(identity?.npub);
      const { mnemonic: m, trustworthy } = await fetchEncryptedMnemonicDetailed(identity, 'user-initiated');
      if (!m) {
        // An empty read is "no backup" only when the relays reliably answered.
        setErr(
          trustworthy
            ? 'No backup found on your write relays.'
            : 'Could not reach enough of your relays to check. A backup may exist. Try again.',
        );
        setInternalMode('idle');
        return;
      }
      await sparkInitFromMnemonic({ mnemonic: m, ownerPubkey: identity.pubkey });
      setInternalMode('idle');
      onConnected?.();
    } catch (e) {
      setErr(sparkFailureIs(e) ? null : getErrorMessage(e, 'failed to restore wallet'));
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
      // wallet is already backed up, or when we could not tell. Re-pasting the
      // same seed is harmless.
      const verdict = await overwriteVerdict(trimmed);
      if (verdict !== 'safe') {
        const ok = await confirmOverwrite(verdict, 'Connecting this seed');
        if (!ok) { setInternalMode('idle'); return; }
      }
      storage.sparkOptOut.clear(identity?.npub);
      setUnbacked(null);
      await sparkInitFromMnemonic({ mnemonic: trimmed, ownerPubkey: identity.pubkey });
      // Back up so silent auto-restore works on the next load. Non-fatal: the
      // wallet is already up and the user holds the seed they just pasted, so
      // failing the connect over the backup would be the worse trade.
      //
      // But say so ON SCREEN, not only in the console. `publishEncryptedMnemonic`
      // throws when the event reached no relay, and that case is exactly "the
      // seed you just connected has no backup" — the login backfill won't cover
      // it either, since that path only ever republishes a seed WE derived. The
      // card says it and offers the retry (`UnbackedWallet`), and the window
      // stays open on it. Message only, never the seed.
      const owner = identity;
      const backUp = () => publishEncryptedMnemonic(owner, trimmed);
      let backedUp = true;
      await backUp().catch((e) => {
        backedUp = false;
        console.warn('[spark] wallet backup failed:', getErrorMessage(e, 'unknown'));
      });
      setPasteSeed('');
      setInternalMode('idle');
      if (backedUp) {
        onConnected?.();
      } else {
        setUnbacked({ npub: owner.npub, isActive: () => sparkSeedIsActive(trimmed), backUp });
        onConnected?.({ keepOpen: true });
      }
    } catch (e) {
      setErr(sparkFailureIs(e) ? null : getErrorMessage(e, 'failed to connect wallet'));
      setInternalMode('idle');
    }
  }

  async function disconnect() {
    setUnbacked(null);
    await sparkDisconnect();
    storage.sparkOptOut.set(identity?.npub);
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
        <SparkFailureNotice op="connect" />
        {err && <div className="text-[11px] text-nostr/80">{err}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {confirmEl}
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
          aria-label="Seed phrase"
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
      <SparkFailureNotice op="connect" />
      {err && <div className="text-[11px] text-nostr/80">{err}</div>}
    </div>
  );
}

function ReadyPanel({ owner, onDisconnect }: { owner: string | null; onDisconnect: () => void }) {
  const identity = useApp((s) => s.identity);
  const unbackedWallet = useUnbackedWallet(identity?.npub);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupErr, setBackupErr] = useState<string | null>(null);
  const [backupSaved, setBackupSaved] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showReceive, setShowReceive] = useState(false);
  const [amountSats, setAmountSats] = useState('');
  const [generating, setGenerating] = useState(false);
  const [invoice, setInvoice] = useState<string | null>(null);
  const [feeSats, setFeeSats] = useState<number | null>(null);
  const [copied, flashCopied, clearCopied] = useFlash<true>(1500);

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
    setGenerating(true); setErr(null); setInvoice(null); setFeeSats(null); clearCopied();
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
    try { await navigator.clipboard.writeText(invoice); flashCopied(true); }
    catch { /* ignore */ }
  }

  async function backUpAgain() {
    if (!unbackedWallet) return;
    setBackupBusy(true);
    setBackupErr(null);
    try {
      await unbackedWallet.backUp();
      setUnbacked(null);
      setBackupSaved(true);
    } catch (e) {
      setBackupErr(getErrorMessage(e, 'the backup failed'));
    } finally {
      setBackupBusy(false);
    }
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
          className="text-muted hover:text-bolt ml-2 min-h-6 min-w-6 disabled:opacity-30"
          title="Re-read balance from the SDK"
          // The glyph is the content, and content outranks `title` in the
          // accessible-name algorithm — so the name was "↻".
          aria-label="Refresh balance"
        >
          {refreshing ? '…' : '↻'}
        </button>
      </div>

      {/* See `UnbackedWallet`. It states the COST (this wallet is gone after
          a reload) rather than the mechanism, and never shows the seed. */}
      {unbackedWallet && (
        <div role="status" className="card border-bolt/40 p-3 space-y-2 break-words">
          <p className="text-bolt">
            This wallet has no backup on Nostr: the backup reached none of your relays.
          </p>
          <p className="text-muted">
            After a reload, this app opens the wallet in your Nostr backup, or none, and not
            this one. Keep the seed phrase you pasted.
          </p>
          <button onClick={backUpAgain} disabled={backupBusy} className="btn-bolt disabled:opacity-40">
            {backupBusy ? 'Backing up…' : 'Back up again'}
          </button>
          {backupErr && <div className="text-nostr/80">The backup failed again: {backupErr}</div>}
        </div>
      )}
      {backupSaved && !unbackedWallet && (
        <div className="text-muted">✓ Backed up to Nostr.</div>
      )}

      {!showReceive && !invoice && (
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setShowReceive(true)} className="btn-ghost">Receive</button>
          <button onClick={onDisconnect} className="btn-mini">Disconnect</button>
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
              inputMode="numeric"
              min={1}
              placeholder="amount in sats (optional)"
              aria-label="Amount in sats (optional)"
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
          <button onClick={() => setShowReceive(false)} className="btn-mini">cancel</button>
        </div>
      )}

      {invoice && (
        <div className="space-y-2">
          <div className="text-muted">
            Scan with another Lightning wallet, or copy the BOLT11 below.
            Balance updates the moment Spark claims the deposit.
            {feeSats != null && feeSats > 0 ? ` Network fee: ${feeSats.toLocaleString()} sats.` : ''}
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
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={copy} className="btn-ghost">{copied ? 'Copied' : 'Copy'}</button>
            <button onClick={clearInvoice} className="btn-mini">done</button>
          </div>
        </div>
      )}

      <SparkFailureNotice op="balance" />
      {err && <div className="text-nostr/80">{err}</div>}
    </div>
  );
}

/**
 * The last Spark failure, said where the person is looking (#304).
 *
 * `connect` sits on the form: a wallet the page-load restore could not open
 * used to leave the picker looking as if there had never been one. `balance`
 * sits on the card, where a failed read used to leave "—" with no cause. The
 * cause comes first, in words (`sparkFailureCause`), then the error's own text
 * — it stays on this device; the bug report's log gets a fixed word only.
 */
function SparkFailureNotice({ op }: { op: SparkFailure['op'] }) {
  const failure = useSyncExternalStore(subscribeSparkFailure, sparkLastFailure, () => null);
  if (!failure || failure.op !== op) return null;
  const isFirefox = typeof navigator !== 'undefined' && /Firefox\//.test(navigator.userAgent);
  return (
    <div role="status" className="card border-nostr/40 p-3 space-y-1 text-xs leading-relaxed" data-spark-failure={op}>
      <p className="text-bone">
        {op === 'connect' ? 'Your Spark wallet did not open.' : 'Spark could not read the balance.'}
      </p>
      <p className="text-bone/80">{sparkFailureCause(failure.code, isFirefox)}</p>
      <p className="font-mono text-[11px] text-muted break-words" data-spark-failure-detail>{failure.detail}</p>
    </div>
  );
}
