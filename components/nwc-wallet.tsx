'use client';

import { useEffect, useState } from 'react';
import {
  hasNwc, saveNwcUri, clearNwcUri, loadNwcUri, nwcValidate,
  nwcFetchCapabilities, nwcGetMethods, nwcGetBudget, type NwcBudget,
} from '@/lib/v4v/nwc';
import {
  publishEncryptedNwc, deleteEncryptedNwc, fetchEncryptedNwc, fetchEncryptedNwcDetailed,
  getNip44, isAmberActive,
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

interface Props {
  mode: 'form' | 'card';
  onConnected?: () => void;
  onDisconnected?: () => void;
}

// Opt-in checkbox to encrypt + back up the NWC connection string to Nostr.
// Module-scope (not nested in NwcWallet) so it keeps a stable identity across
// the parent's busy/state re-renders — a nested component would remount the
// <input> on every render.
function BackupToggle({ checked, disabled, canBackup, signedIn, amber, onToggle }: {
  checked: boolean;
  disabled: boolean;
  canBackup: boolean;
  signedIn: boolean;
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
            {signedIn ? 'Your signer doesn’t support NIP-44 encryption.' : 'Sign in with Nostr to enable.'}
          </span>
        )}
      </span>
    </label>
  );
}

// One quiet backup auto-check per account per page load. The login-time
// restore in loadProfile is best-effort (relay query + NIP-44 decrypt, both
// can lose a race or time out, failures swallowed) — this is the safety net
// so the user opening the wallet UI never has to click "Restore" themselves.
// Module-scope Set so reopening the modal doesn't re-run the relay query.
const autoCheckedNpubs = new Set<string>();

// Set whenever a connection is restored from the Nostr backup (login-time,
// form auto-check, or the manual button). The connected card shows a one-time
// "✓ Restored" confirmation and clears the flag when it unmounts, so the
// notice appears on the first wallet-modal view after a restore and not on
// every open thereafter.
let restoredFromBackupNpub: string | null = null;
export function markNwcRestored(npub: string) {
  restoredFromBackupNpub = npub;
}

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

  // Backup needs a signed-in identity AND a signer that can NIP-44 encrypt.
  const canBackup = !!identity && getNip44() !== null;

  function bump() { setTick((t) => t + 1); }

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
    fetchEncryptedNwc(identity, 'user-initiated')
      .then((uri) => {
        if (!uri) return;
        // Save even if the modal closed mid-fetch — the restore is global.
        saveNwcUri(uri);
        storage.nwcBackup.set(identity.npub);
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
    mode === 'card' && !!identity && restoredFromBackupNpub === identity.npub;
  useEffect(() => {
    if (!showRestoredNotice) return;
    return () => { restoredFromBackupNpub = null; };
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
    nwcFetchCapabilities().catch(() => {});
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

  async function restoreFromNostr() {
    if (!identity || !canBackup) return;
    setBusy(true);
    setErr(null);
    try {
      const { uri, unreadable } = await fetchEncryptedNwcDetailed(identity, 'user-initiated');
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
      storage.nwcBackup.set(identity.npub);
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
      setNote(null);
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
      await publishEncryptedNwc(identity, uri);
      storage.nwcBackup.set(identity.npub);
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

    const methods = nwcGetMethods();
    const canPayInvoice = methods === null || methods.includes('pay_invoice');
    const canKeysend = methods === null || methods.includes('pay_keysend');

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
          amber={isAmberActive()}
          onToggle={toggleBackup}
        />
        {note && <div className="text-[11px] text-bolt break-words">{note}</div>}
        {err && <div className="text-[11px] text-nostr/80 break-words">{err}</div>}
        <div className="flex gap-3">
          <button
            onClick={disconnect}
            disabled={busy}
            className="text-[11px] text-muted hover:text-nostr disabled:opacity-40"
          >
            {busy ? 'Working…' : 'Disconnect'}
          </button>
          {cardBackup && canBackup && (
            <button
              onClick={republishBackup}
              disabled={busy}
              className="text-[11px] text-muted hover:text-bone disabled:opacity-40"
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
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') connect(); }}
      />
      <BackupToggle
        checked={formBackup}
        disabled={!canBackup || busy}
        canBackup={canBackup}
        signedIn={!!identity}
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
              className="text-[11px] text-muted hover:text-bone disabled:opacity-40"
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
