'use client';

import { useEffect, useState } from 'react';
import { useFlash } from '@/lib/use-flash';
import dynamic from 'next/dynamic';
// Lazy-loaded, matching <SparkWallet>: this card is itself reached only
// through the wallet modal, but qrcode.react has no business in the chunk a
// user pays boosts from.
const QRCodeSVG = dynamic(() => import('qrcode.react').then((m) => m.QRCodeSVG), { ssr: false });
import {
  hasNwc, saveNwcUri, clearNwcUri, loadNwcUri, nwcValidate,
  nwcFetchCapabilities, nwcGetMethods, nwcGetBudget, nwcMakeInvoice,
  subscribeNwcNotifications, type NwcBudget, type NwcInvoice,
} from '@/lib/v4v/nwc';
import { BRAND } from '@/lib/brand';
import { getErrorMessage } from '@/lib/util';
import { timeAgo } from '@/lib/format';
import { markNwcRestored, wasNwcRestored, clearNwcRestored } from '@/lib/v4v/nwc-state';
import {
  publishEncryptedNwc, deleteEncryptedNwc, fetchEncryptedNwcDetailed,
  getNip44, isAmberActive, subscribeSigner,
  readNwcBackupHead, backupIsAnotherDevices, type NwcBackupHead,
} from '@/lib/nostr';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';

/**
 * States what this connection may spend, which is NOT the wallet's balance
 * whenever a budget applies. Both branches are worth printing:
 *
 *  - A budget exists → name it, so a header chip smaller than the wallet's own
 *    balance reads as the grant working rather than as a bug.
 *  - The wallet reports budgets and this connection has none → say so, so a
 *    user whose node balance IS the number on screen knows why, and knows the
 *    repair is a budgeted connection rather than anything in this app.
 *
 * A wallet that never answers `get_budget` gets no line at all — we have no
 * fact to state, and guessing either way would be a claim about someone's
 * spending limit that we did not read.
 */
function BudgetLine({ budget, knowsBudgets }: { budget: NwcBudget | null; knowsBudgets: boolean }) {
  if (budget) {
    const period = budget.renewalPeriod && budget.renewalPeriod !== 'never'
      ? ` \u00b7 renews ${budget.renewalPeriod}`
      : '';
    return (
      <div className="text-[11px] text-muted">
        Budget {budget.remainingSats.toLocaleString()} of{' '}
        {budget.totalSats.toLocaleString()} sats left{period}
      </div>
    );
  }
  if (!knowsBudgets) return null;
  return (
    <div className="text-[11px] text-muted">
      No spending limit on this connection — the balance shown is your whole wallet.
    </div>
  );
}

/**
 * Top up: a BOLT11 the CONNECTED wallet receives, paid from anywhere else.
 *
 * Module-scope for the same reason `<BackupToggle>` is — a nested component
 * remounts its `<input>` on every parent render, and this one holds a
 * half-typed amount.
 *
 * Three things here are deliberate:
 *
 *  - **It stays mounted when collapsed**, and the invoice survives a collapse.
 *    The notification subscription below hangs off the invoice, so unmounting
 *    on "Hide" would silently drop the only confirmation this card can give.
 *  - **The amount is required.** `nwcMakeInvoice` says why: NIP-47 has no
 *    zero-amount invoice, so the Spark card's optional field is not copyable
 *    here.
 *  - **It never claims to be watching.** `subscribeNwcNotifications` returns a
 *    no-op unsub on failure and never rejects, so "am I subscribed?" is a
 *    question this component cannot answer. It therefore states only the
 *    neutral fact until a receipt actually lands, and never a promise about
 *    push support it has not read.
 */
function ReceivePanel() {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [generating, setGenerating] = useState(false);
  const [inv, setInv] = useState<NwcInvoice | null>(null);
  const [copied, flashCopied, clearCopied] = useFlash<true>(1500);
  const [err, setErr] = useState<string | null>(null);
  const [paidSats, setPaidSats] = useState<number | null>(null);

  const hash = inv?.paymentHash;

  // Hold a notification lease for the life of the invoice on screen. The NWC
  // card prints no balance, so a paid top up otherwise has NOTHING on screen
  // to point at — the same gap `note` exists to fill for the Nostr backup.
  useEffect(() => {
    if (!hash) return;
    let cancelled = false;
    let unsub: (() => void) | null = null;
    subscribeNwcNotifications((e) => {
      if (cancelled || e.notification_type !== 'payment_received') return;
      // Match the payment hash. A wallet receives payments that have nothing
      // to do with the invoice on this screen, and calling one of those "your
      // top up arrived" is a statement about someone's money we did not read.
      if (e.notification.payment_hash !== hash) return;
      setPaidSats(Math.floor((e.notification.amount ?? 0) / 1000));
      setInv(null);
      setAmount('');
    }).then((fn) => {
      if (cancelled) { fn(); return; }
      unsub = fn;
    }).catch(() => { /* no push support — the neutral text already covers it */ });
    return () => { cancelled = true; if (unsub) unsub(); };
  }, [hash]);

  async function generate() {
    setGenerating(true);
    setErr(null);
    setPaidSats(null);
    clearCopied();
    try {
      const res = await nwcMakeInvoice({
        amountSats: Number(amount),
        description: `${BRAND.wireName} top up`,
      });
      setInv(res);
    } catch (e) {
      setErr(getErrorMessage(e, 'failed to create an invoice'));
    } finally {
      setGenerating(false);
    }
  }

  async function copy() {
    if (!inv) return;
    try {
      await navigator.clipboard.writeText(inv.invoice);
      flashCopied(true);
    } catch { /* ignore */ }
  }

  return (
    <div className="space-y-2 text-[11px]">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => setOpen((v) => !v)}
          className="btn-mini"
        >
          {open ? 'Hide top up' : '↓ Top up'}
        </button>
        {inv && !open && <span className="text-muted min-h-6">invoice waiting</span>}
      </div>

      {paidSats !== null && (
        <div className="text-[11px] text-bolt border border-bolt/40 bg-bolt/10 px-2 py-1.5">
          ✓ Received {paidSats.toLocaleString()} sats
        </div>
      )}

      {open && (
        <>
          {!inv && (
            <div className="space-y-2">
              <div className="text-muted">
                Pay this invoice from any other Lightning wallet to add sats to
                the wallet this connection points at.
              </div>
              <div className="flex gap-2">
                <input
                  className="input"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  placeholder="amount in sats"
                  aria-label="Amount in sats"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <button
                  onClick={generate}
                  disabled={generating || !amount.trim()}
                  className="btn-bolt disabled:opacity-30"
                >
                  {generating ? 'Generating…' : 'Generate'}
                </button>
              </div>
            </div>
          )}

          {inv && (
            <div className="space-y-2">
              <div className="text-muted">
                Scan with another Lightning wallet, or copy the BOLT11 below.
                Your balance updates when the invoice is paid.
              </div>
              <div className="flex justify-center bg-bone p-3">
                <QRCodeSVG
                  value={`lightning:${inv.invoice}`}
                  size={200}
                  level="M"
                  fgColor="#0a0a08"
                  bgColor="#f5f1e8"
                />
              </div>
              {/* `break-all` for the same reason the host line above has it:
                  a BOLT11 has no space to wrap at, and without it the modal's
                  scroll pane grows and the whole sheet scrolls sideways. */}
              <code className="block card p-2 text-[10px] leading-snug break-all select-all">
                {inv.invoice}
              </code>
              <div className="flex flex-wrap items-center gap-3">
                <button onClick={copy} className="btn-ghost">{copied ? 'Copied' : 'Copy'}</button>
                <button
                  onClick={() => { setInv(null); setAmount(''); clearCopied(); }}
                  className="btn-mini"
                >
                  New amount
                </button>
              </div>
            </div>
          )}

          {err && <div className="text-[11px] text-nostr/80 break-words">{err}</div>}
        </>
      )}
    </div>
  );
}

interface Props {
  mode: 'form' | 'card';
  onConnected?: () => void;
  onDisconnected?: () => void;
}

// Opt-in checkbox to encrypt + back up the NWC connection string to Nostr.
// Module-scope (not nested in NwcWallet) so it keeps a stable identity across
// the parent's busy/state re-renders — a nested component would remount the
// <input> on every render.
function BackupToggle({ checked, disabled, canBackup, signedIn, signerPending, amber, onToggle }: {
  checked: boolean;
  disabled: boolean;
  canBackup: boolean;
  signedIn: boolean;
  /** Signed in with a remote signer whose adapter has not installed yet — a
   *  signer that is still reconnecting, NOT one without NIP-44. */
  signerPending: boolean;
  /** Amber is the active signer, so this costs two approvals — see below. */
  amber: boolean;
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
            {/* One backup is TWO NIP-55 round trips — nip44_encrypt, then
                sign_event — and Amber returns by clipboard, so the user has to
                come back and tap the page between them. Unannounced, the second
                prompt reads as the first one repeating, which is exactly the
                "the prompt comes straight back" failure docs/signers.md
                describes people giving up on. */}
            {amber && ' Amber asks twice: once to encrypt, once to sign. Approve both, and return to this app after each.'}
          </span>
        ) : (
          <span className="block text-muted">
            {!signedIn
              ? 'Sign in with Nostr to enable.'
              : signerPending
                ? 'Waiting for your signer to connect.'
                : 'Your signer doesn’t support NIP-44 encryption.'}
          </span>
        )}
      </span>
    </label>
  );
}

/**
 * Whether the backup on Nostr is THIS device's connection.
 *
 * The checkbox cannot say it. It records that this device once published, and
 * one account on two devices is two writers at one coordinate: both boxes stay
 * checked while only the last publish is on the relays, so a phone restoring
 * from Nostr gets whichever device backed up last. Reported 2026-09-23 as two
 * balances for one account — an Android app and an iPhone app each holding a
 * different connection, both "backed up".
 *
 * Silent while the read has not answered or could not say, and for an OLDER
 * event than this device's own, which is a relay that missed our publish
 * rather than another writer.
 */
function BackupStatus({ head, written, canRepair }: {
  head: NwcBackupHead;
  written: { id: string; createdAt: number } | null;
  canRepair: boolean;
}) {
  const repair = canRepair ? ' Tap Back up again to save this connection instead.' : '';
  let text: string | null = null;
  let ok = false;
  if (head.state === 'none') {
    text = `There is no backup on Nostr now. It was removed, possibly from another device.${canRepair ? ' Tap Back up again to save this connection.' : ''}`;
  } else if (head.state === 'present') {
    if (written && head.id === written.id) {
      text = '✓ The backup on Nostr is this connection.';
      ok = true;
    } else if (!written) {
      text = `This device can’t tell whether the backup on Nostr is this connection.${repair}`;
    } else if (backupIsAnotherDevices(head, written)) {
      text = `The backup on Nostr is a different connection, saved ${timeAgo(head.createdAt)} — probably from another device.${repair}`;
    }
  }
  if (!text) return null;
  return <div className={`text-[11px] break-words ${ok ? 'text-muted' : 'text-bolt/80'}`}>{text}</div>;
}

// One quiet backup auto-check per account per page load. The login-time
// restore in loadProfile is best-effort (relay query + NIP-44 decrypt, both
// can lose a race or time out, failures swallowed) — this is the safety net
// so the user opening the wallet UI never has to click "Restore" themselves.
// Module-scope Set so reopening the modal doesn't re-run the relay query.
const autoCheckedNpubs = new Set<string>();


export function NwcWallet({ mode, onConnected, onDisconnected }: Props) {
  const [, setTick] = useState(0);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  // Confirmation for an action whose whole result is invisible — the backup
  // lives on a relay, so "it worked" has nothing on screen to point at. The
  // checkbox cannot carry it: it is already checked before the tap.
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [budget, setBudget] = useState<NwcBudget | null>(null);
  const [autoChecking, setAutoChecking] = useState(false);
  const identity = useApp((s) => s.identity);
  // Form-only opt-in choice (applied when the user clicks Connect). The
  // connected card reads the authoritative stored flag live instead, so an
  // auto-restore or an identity arriving async is always reflected.
  const [formBackup, setFormBackup] = useState(false);

  // What sits at the backup coordinate, read without a decrypt on card open.
  // `unknown` until it answers — and after a read that could not say.
  const [head, setHead] = useState<NwcBackupHead>({ state: 'unknown' });

  // Backup needs a signed-in identity AND a signer that can NIP-44 encrypt.
  // Read during render, so the subscription below is what makes it current: a
  // NIP-46 signer installs its adapter AFTER page load, and a card that opened
  // first used to say the signer had no NIP-44 for as long as it stayed open.
  const canBackup = !!identity && getNip44() !== null;
  const signerPending = !!identity && !canBackup && storage.signer.get() === 'bunker';

  function bump() { setTick((t) => t + 1); }

  useEffect(() => subscribeSigner(bump), []);

  // Record the event a publish or a restore produced, so this device knows
  // WHICH backup it wrote — see `storage.nwcBackup.written`.
  function recordBackup(npub: string, event: { id: string; created_at: number }) {
    storage.nwcBackup.set(npub, event);
    setHead({ state: 'present', id: event.id, createdAt: event.created_at });
  }

  /**
   * Tombstone the backup only when it is not another device's.
   *
   * Reads the head first — a plain read, no decrypt, so no extra signer
   * prompt. When the backup is a NEWER connection than the one this device
   * wrote, deleting it would remove the other device's restore, so it is left
   * alone and only this device's flag is cleared. Returns whether it was left.
   */
  async function removeBackupIfOurs(id: NonNullable<typeof identity>): Promise<'removed' | 'left'> {
    const current = await readNwcBackupHead(id).catch((): NwcBackupHead => ({ state: 'unknown' }));
    setHead(current);
    if (backupIsAnotherDevices(current, storage.nwcBackup.written(id.npub))) {
      storage.nwcBackup.clear(id.npub);
      return 'left';
    }
    await deleteEncryptedNwc(id);
    storage.nwcBackup.clear(id.npub);
    setHead({ state: 'none' });
    return 'removed';
  }

  // Auto-restore on form mount: if this device has no NWC URI but the account
  // has an encrypted backup on Nostr, restore it without a manual click. Runs
  // at most once per npub per page load; "no backup found" stays silent (the
  // manual restore button remains for retries).
  useEffect(() => {
    if (mode !== 'form' || hasNwc()) return;
    if (!identity || getNip44() === null) return;
    if (autoCheckedNpubs.has(identity.npub)) return;
    autoCheckedNpubs.add(identity.npub);
    let cancelled = false;
    setAutoChecking(true);
    fetchEncryptedNwcDetailed(identity, 'user-initiated')
      .then(({ uri, event }) => {
        if (!uri) return;
        // Save even if the modal closed mid-fetch — the restore is global.
        saveNwcUri(uri);
        storage.nwcBackup.set(identity.npub, event ?? undefined);
        markNwcRestored(identity.npub);
        if (!cancelled) { bump(); onConnected?.(); }
      })
      .catch(() => { /* decrypt unavailable / relay miss — manual button remains */ })
      .finally(() => { if (!cancelled) setAutoChecking(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, identity]);

  // One-time restore confirmation: visible while this card mount lives,
  // cleared on unmount so the next modal open shows the plain card.
  const showRestoredNotice =
    mode === 'card' && !!identity && wasNwcRestored(identity.npub);
  useEffect(() => {
    if (!showRestoredNotice) return;
    return () => { clearNwcRestored(); };
  }, [showRestoredNotice]);

  // Lazily fetch capabilities on first card render so we can warn the user if
  // their wallet doesn't advertise payment methods via get_info.
  //
  // Guarded on `mode` here rather than living inside the `mode === 'card'`
  // branch below, matching the auto-restore effect above. It was written as a
  // conditional hook with a `rules-of-hooks` suppression, which happens to be
  // safe today only because the card and form elements sit at different child
  // positions in <WalletModal>, so React remounts instead of reusing the
  // instance. Nothing states that invariant at either site: align those
  // positions in a future refactor, or pass a `mode` that flips on a live
  // instance, and the hook count changes between renders — React throws
  // "Rendered fewer hooks than expected" and takes the whole wallet modal down.
  useEffect(() => {
    if (mode !== 'card' || !hasNwc()) return;
    if (nwcGetMethods() !== null) return; // already fetched this session
    // The result is READ DURING RENDER (`nwcGetMethods()` below), so the fetch
    // has to force a repaint of its own. It used to drop the answer, and the
    // card repainted only because `nwcGetBudget` happens to set state a moment
    // later — incidental, and not something the receive button below can rest
    // on, since it is hidden until the method list names `make_invoice`.
    nwcFetchCapabilities().then(bump).catch(() => {});
  }, [mode]);

  // The connection's spending budget, read once per card open. This is the
  // card that answers "why is the number in the header not what my wallet
  // says" — on a connection to your own node, `get_balance` reports the NODE's
  // balance while the grant this app holds is whatever budget the connection
  // was made with, and nothing on screen used to name the difference.
  //
  // `null` covers both "no budget" and "this wallet does not report one", so
  // the card states the first only when it also knows the wallet answers the
  // question at all — a method list naming `get_budget`.
  useEffect(() => {
    if (mode !== 'card' || !hasNwc()) return;
    let cancelled = false;
    nwcGetBudget()
      .then((b) => { if (!cancelled) setBudget(b); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [mode]);

  // Is the backup on Nostr still THIS device's connection? Read on card open,
  // and again when the signed-in account changes. A plain read of the event's
  // id — never a decrypt, which on Amber or Clave would put the connection
  // string on an approval sheet the user did not ask for.
  //
  // Read whether or not this device has the backup flag. A device that already
  // held a connection when the user signed in keeps it and never restores
  // (restore runs only with no local connection), so it can be using an OLD
  // wallet while a different backup sits on Nostr, with no flag and nothing
  // on screen to say so.
  const cardOpen = mode === 'card' && !!identity;
  useEffect(() => {
    if (!cardOpen || !identity) return;
    let cancelled = false;
    readNwcBackupHead(identity)
      .then((h) => { if (!cancelled) setHead(h); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [cardOpen, identity]);

  /**
   * Replace this device's connection with the one backed up on Nostr.
   *
   * The repair for a device that kept an old connection across sign-in. It
   * decrypts, so it runs only on the user's tap ('user-initiated'). It never
   * touches the backup — the local connection is simply dropped, which is the
   * whole point: tombstoning here would delete the connection the user asked
   * to switch TO.
   */
  async function useBackupInstead() {
    if (!identity || !canBackup || busy) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const { uri, unreadable, event } = await fetchEncryptedNwcDetailed(identity, 'user-initiated');
      if (!uri) {
        setErr(unreadable
          ? 'The backup on Nostr could not be read. This connection stays.'
          : 'No backup found on Nostr for this account. This connection stays.');
        return;
      }
      storage.walletBalance.clear(identity.npub);
      saveNwcUri(uri);
      if (event) recordBackup(identity.npub, event);
      else storage.nwcBackup.set(identity.npub);
      markNwcRestored(identity.npub);
      setBudget(null);
      nwcGetBudget().then(setBudget).catch(() => {});
      bump();
    } catch (e) {
      setErr(`Couldn’t use the backup: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  }

  async function restoreFromNostr() {
    if (!identity || !canBackup) return;
    setBusy(true);
    setErr(null);
    try {
      const { uri, unreadable, event } = await fetchEncryptedNwcDetailed(identity, 'user-initiated');
      if (!uri) {
        // Two different facts, and the second one names its own repair. An
        // unreadable backup is one this account owns and cannot use — the shape
        // Amber wrote for every Android backup made before `encodeAmberSafe`,
        // since it truncated the connection string at its own `?relay=`.
        setErr(unreadable
          ? 'The backup on Nostr could not be read. Connect this wallet again with the backup box ticked to replace it.'
          : 'No backup found on Nostr for this account.');
        return;
      }
      saveNwcUri(uri);
      storage.nwcBackup.set(identity.npub, event ?? undefined);
      markNwcRestored(identity.npub);
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
          const note = await publishEncryptedNwc(identity, uri);
          recordBackup(identity.npub, note.event);
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
      setNote(null);
      try {
        await removeBackupIfOurs(identity);
      } catch (e) {
        setErr(`Couldn’t remove the Nostr backup: ${e instanceof Error ? e.message : 'unknown error'}. Tap Disconnect again to retry.`);
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    clearNwcUri();
    storage.walletBalance.clear(identity?.npub);
    // Clear the session stash so this wallet can't be resurrected by a
    // sign-out + sign-in on the same tab after an explicit disconnect.
    if (identity) storage.nwcSessionUri.clear(identity.npub);
    bump();
    onDisconnected?.();
  }

  /**
   * Publish this device's connection over whatever sits at the backup
   * coordinate, without reading it first.
   *
   * It exists because the checkbox is not evidence. It records that a publish
   * once resolved, and two things it cannot see make that a weak claim: a
   * backup written from Amber before `encodeAmberSafe` shipped holds a
   * connection string truncated at its own `?relay=`, and the same-tab
   * sign-out/sign-in fast path in `doLoadProfile` sets the flag from a
   * sessionStorage stash that never went near a relay. Neither is visible from
   * this card, and the user's only symptom arrives on a different device, weeks
   * later, as a connection that does not come back.
   *
   * Deliberately a blind write and not a verify-then-repair. kind:30078 is
   * replaceable and this app is the only writer at this coordinate, so
   * overwriting costs nothing when the backup was already fine — while reading
   * first would cost a THIRD Amber approval to answer a question whose every
   * answer leads to the same publish.
   */
  async function republishBackup() {
    if (!canBackup || !identity || busy) return;
    const uri = loadNwcUri();
    if (!uri) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const published = await publishEncryptedNwc(identity, uri);
      recordBackup(identity.npub, published.event);
      setNote('✓ Backup replaced with this connection.');
    } catch (e) {
      setErr(`Backup failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleBackup(next: boolean) {
    if (!canBackup || !identity || busy) return;
    const uri = loadNwcUri();
    if (next && !uri) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      if (next) {
        const published = await publishEncryptedNwc(identity, uri!);
        recordBackup(identity.npub, published.event);
      } else if (await removeBackupIfOurs(identity) === 'left') {
        setNote('Stopped backing up this connection. The backup on Nostr is another device’s connection, so it stays.');
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

    const methods = nwcGetMethods();
    const canPayInvoice = methods === null || methods.includes('pay_invoice');
    const canKeysend = methods === null || methods.includes('pay_keysend');
    // Same optimistic-when-unknown shape as the two above: an unread method
    // list offers the control, a read one that omits `make_invoice` hides it.
    // Hiding rather than disabling is the point — a pay-only connection is a
    // normal thing to hold, and a dead button reads as a broken app.
    const canMakeInvoice = methods === null || methods.includes('make_invoice');

    return (
      <div className="space-y-2">
        {showRestoredNotice && (
          <div className="text-[11px] text-bolt border border-bolt/40 bg-bolt/10 px-2 py-1.5">
            ✓ Connection restored from your Nostr backup
          </div>
        )}
        {/* `break-all`, because this is the wallet's 64-hex pubkey and has no
            space to wrap at. Without it the line is ~600px of monospace on a
            390px screen: the modal's scroll pane grows to fit and the whole
            sheet scrolls sideways, with the title and the Disconnect button
            parked off the left edge. `truncate` is the wrong fix — the tail of
            the key is how you tell two connections apart. */}
        {host && <div className="text-[11px] text-muted break-all">{host}</div>}
        <BudgetLine budget={budget} knowsBudgets={methods !== null && methods.includes('get_budget')} />
        {methods !== null && !canPayInvoice && (
          <div className="text-[11px] text-nostr/80 border border-nostr/30 bg-nostr/5 px-2 py-1.5">
            ⚠ This wallet does not support sending payments via NWC. Boosts will fail. Try Alby or Mutiny.
          </div>
        )}
        {methods !== null && canPayInvoice && !canKeysend && (
          <div className="text-[11px] text-bolt/80">
            ⚠ Keysend not supported — node-pubkey recipients (most podcast splits) will fail. Try Alby or Mutiny.
          </div>
        )}
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
          signerPending={signerPending}
          amber={isAmberActive()}
          onToggle={toggleBackup}
        />
        {cardBackup && identity && (
          <BackupStatus head={head} written={storage.nwcBackup.written(identity.npub)} canRepair={canBackup} />
        )}
        {/* No flag, and a backup IS on Nostr: this device neither wrote nor
            restored it, so it is almost certainly running its own connection
            — an old one kept across sign-in. Say so, and offer the switch. */}
        {!cardBackup && identity && head.state === 'present' && (
          <div className="text-[11px] text-bolt/80 break-words space-y-1.5">
            <div>
              This device uses its own connection. The backup on Nostr (saved {timeAgo(head.createdAt)}) was
              not made or restored here, so it is probably a different connection. Ticking the box above
              replaces that backup with this connection.
            </div>
            {canBackup && (
              <button onClick={useBackupInstead} disabled={busy} className="btn-mini disabled:opacity-40">
                ↩ Use the backup instead
              </button>
            )}
          </div>
        )}
        {note && <div className="text-[11px] text-bolt break-words">{note}</div>}
        {err && <div className="text-[11px] text-nostr/80 break-words">{err}</div>}
        {canMakeInvoice && <ReceivePanel />}
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={disconnect}
            disabled={busy}
            className="btn-mini disabled:opacity-40"
          >
            {busy ? 'Working…' : 'Disconnect'}
          </button>
          {cardBackup && canBackup && (
            <button
              onClick={republishBackup}
              disabled={busy}
              className="btn-mini disabled:opacity-40"
            >
              ↻ Back up again
            </button>
          )}
        </div>
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
        aria-label="NWC connection string (nostr+walletconnect://)"
        // A pasted credential, hand-edited on a phone: iOS would otherwise
        // capitalise the first letter and autocorrect the rest.
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') connect(); }}
      />
      <BackupToggle
        checked={formBackup}
        disabled={!canBackup || busy}
        canBackup={canBackup}
        signedIn={!!identity}
        signerPending={signerPending}
        amber={isAmberActive()}
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
          {autoChecking ? (
            <div className="text-[11px] text-muted animate-bolt">
              Checking Nostr for a saved connection…
            </div>
          ) : (
            <button
              onClick={restoreFromNostr}
              disabled={busy}
              className="btn-mini disabled:opacity-40"
            >
              {busy ? 'Restoring…' : '↩ Restore from Nostr backup'}
            </button>
          )}
        </div>
      )}
      {err && <div className="text-[11px] text-nostr/80 break-words">{err}</div>}
    </div>
  );
}
