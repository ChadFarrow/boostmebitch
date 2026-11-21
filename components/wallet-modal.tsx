'use client';

import { useWalletChange } from '@/lib/use-wallet-change';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { ModalShell } from './modal-shell';
import { hasNwc } from '@/lib/v4v/nwc-state';
import { hasSpark, sparkAvailable } from '@/lib/v4v/spark';
import { hasWebln, isWeblnEnabled, weblnEnable } from '@/lib/v4v/webln';
import { clearOtherWallets } from '@/lib/v4v/wallets';
import { recordLastRail } from '@/lib/nostr';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
// `next/dynamic`: <NwcWallet> imports the SDK-bearing lib/v4v/nwc.ts, and this
// modal is mounted by <WalletModalHost> in the root layout — a static import
// put `@getalby/sdk` in every route's first load. See lib/v4v/nwc-state.ts.
const NwcWallet = dynamic(() => import('./nwc-wallet').then((m) => m.NwcWallet), { ssr: false });
import { SparkWallet } from './spark-wallet';
import { WeblnWallet } from './webln-wallet';
import { StreamRate, StreamedLog } from './streaming-settings';
import { DefaultAmounts } from './boost-modal/default-amounts';

type Rail = 'nwc' | 'spark' | 'webln';

// `picked`: a tap in the picker chose this form. False when the modal opened
// straight on it because the picker would have had one row — that tap is what
// consents to the form's backup read, so without it the read waits for one.
type WalletView =
  | { kind: 'picker'; switching: boolean }
  | { kind: 'connecting'; rail: Rail; switching: boolean; picked: boolean }
  | { kind: 'connected' };

type PickerRow = { rail: Rail; icon: string; title: string; desc: string };

// The rows the picker offers. Read per call, not captured: an extension can
// inject `window.webln` after the modal mounted.
function pickerRows(): PickerRow[] {
  return [
    ...(hasWebln()
      ? [{ rail: 'webln' as const, icon: '◈', title: 'WebLN', desc: 'Use the Alby browser extension · tap to enable' }]
      : []),
    // Plain words first, the protocol name second: these three rows are the
    // first thing a newcomer reads about paying, and "NWC · Paste a
    // nostr+walletconnect:// URI" told them nothing about which to pick.
    { rail: 'nwc', icon: '⚡', title: 'NWC', desc: 'Connect a Lightning wallet you already have (Nostr Wallet Connect)' },
    // Not inside the iOS app, which holds no funds (`sparkAvailable`).
    ...(sparkAvailable()
      ? [{ rail: 'spark' as const, icon: '✶', title: 'Spark', desc: 'A wallet this app creates and backs up for you — self-custodial' }]
      : []),
  ];
}

// A picker with one row is not a choice — inside the iOS app it is NWC alone.
// The modal skips it: the wallet button opens that rail's form, Disconnect
// returns to it, and "Switch wallet" is not offered (docs/wallets.md).
function onlyPickerRow(): PickerRow | null {
  const rows = pickerRows();
  return rows.length === 1 ? rows[0] : null;
}

// Where the modal stands with nothing connected — and where it opens.
function firstView(): WalletView {
  if (getActiveRail() !== null) return { kind: 'connected' };
  const only = onlyPickerRow();
  return only
    ? { kind: 'connecting', rail: only.rail, switching: false, picked: false }
    : { kind: 'picker', switching: false };
}

function railConnected(rail: Rail): boolean {
  return rail === 'nwc' ? hasNwc() : rail === 'spark' ? hasSpark() : isWeblnEnabled();
}

// Mirrors pickRail() (rail pref first, then NWC > Spark > WebLN priority)
// but gates WebLN on isWeblnEnabled — inside the wallet UI "active" means
// the user explicitly enabled it, not merely that the extension exists.
function getActiveRail(): Rail | null {
  const pref = storage.railPref.get();
  if (pref && railConnected(pref)) return pref;
  if (hasNwc()) return 'nwc';
  if (hasSpark()) return 'spark';
  if (isWeblnEnabled()) return 'webln';
  return null;
}

interface Props {
  onClose: () => void;
}

export function WalletModal({ onClose }: Props) {
  const identity = useApp((s) => s.identity);
  const backupWithheld = useApp((s) => s.walletBackupWithheld);
  const [view, setView] = useState<WalletView>(firstView);
  // Sync view when wallet state changes externally (e.g. auto-restore completes
  // after the modal is already open, or a disconnect fires from outside).
  useWalletChange(() => {
    setView((v) => {
      const active = getActiveRail();
      if (v.kind === 'connected' && !active) return firstView();
      if (v.kind === 'picker' && !v.switching && active) return { kind: 'connected' };
      // Auto-restore completing while the form for that rail is showing:
      // flip straight to connected without requiring the user to re-paste.
      if (v.kind === 'connecting' && active === v.rail) return { kind: 'connected' };
      return v;
    });
  });


  async function handleConnected(rail: Rail) {
    await clearOtherWallets(rail, identity?.npub);
    onClose();
  }

  // Tapping an ALREADY-CONNECTED rail in the switch picker makes it the
  // active payer (rail pref → pickRail / balance chip / menu summary follow)
  // without touching the other connections. Only connecting a NEW wallet
  // disconnects the others (clearOtherWallets in handleConnected).
  function handlePickerClick(rail: Rail, switching: boolean) {
    if (switching && railConnected(rail)) {
      recordLastRail(rail, identity);
      setView({ kind: 'connected' });
      return;
    }
    if (rail === 'webln') { void handleWeblnPickerClick(switching); return; }
    setView({ kind: 'connecting', rail, switching, picked: true });
  }

  async function handleWeblnPickerClick(switching: boolean) {
    // WebLN has only one action — skip the form, enable inline, close on success.
    try {
      await weblnEnable();
      await clearOtherWallets('webln', identity?.npub);
      onClose();
    } catch {
      // Enable failed (user denied) — fall back to the form so they see the error.
      setView({ kind: 'connecting', rail: 'webln', switching, picked: true });
    }
  }

  function handleDisconnected() {
    setView(firstView());
  }

  const activeRail = getActiveRail();
  const onlyRow = onlyPickerRow();

  let headerTitle = 'Connect a wallet';
  let headerSub: string | null = 'Pick one to send Lightning payments.';
  if (view.kind === 'connected') {
    headerTitle = activeRail === 'nwc' ? 'NWC'
      : activeRail === 'spark' ? 'Spark'
      : activeRail === 'webln' ? 'WebLN'
      : 'Lightning Wallet';
    headerSub = null;
  } else if (view.kind === 'connecting') {
    headerTitle = view.rail === 'nwc' ? 'NWC' : view.rail === 'spark' ? 'Spark' : 'WebLN';
    // No picker row explained this rail, so the header does.
    headerSub = view.picked ? null : onlyRow?.desc ?? null;
  } else if (view.kind === 'picker' && view.switching) {
    headerTitle = 'Switch wallet';
    headerSub = null;
  }

  function renderBody() {
    if (view.kind === 'connected') {
      return (
        <div className="p-5 space-y-4">
          {activeRail === 'nwc' && (
            <NwcWallet mode="card" onDisconnected={handleDisconnected} />
          )}
          {activeRail === 'spark' && (
            <SparkWallet mode="card" onDisconnected={handleDisconnected} />
          )}
          {activeRail === 'webln' && (
            <WeblnWallet mode="card" onDisconnected={handleDisconnected} />
          )}
          {!activeRail && (
            <div className="text-[11px] text-muted">No wallet active.</div>
          )}
          {/* The amount each boost surface opens with, all three together. Here
              for the reason streaming is below: this is where the user looks
              at what they spend. It opens ON TOP of an open boost modal, so it
              and that modal's SET AS DEFAULT re-read on subscribeAmountDefaults
              (docs/money-boosts.md, "Default amounts"). */}
          <div className="border-t border-bone/15 pt-4">
            <DefaultAmounts />
          </div>
          {/* Streaming lives with the wallet, not in a settings page: it's a
              standing instruction to spend from THIS wallet without asking
              again, so the place it's turned on should be the place the user
              is looking at their balance — and the same place the record of
              what it has cost them lives. */}
          <div className="border-t border-bone/15 pt-4 space-y-4">
            <StreamRate />
            <StreamedLog npub={identity?.npub} />
          </div>
          {!onlyRow && (
            <div className="border-t border-bone/15 pt-3 text-center">
              <button
                onClick={() => setView({ kind: 'picker', switching: true })}
                className="btn-mini"
              >
                Switch wallet →
              </button>
            </div>
          )}
        </div>
      );
    }

    if (view.kind === 'connecting') {
      const { rail, switching, picked } = view;
      // Nothing to go back to when the modal opened straight on this form.
      const back: WalletView | null = switching
        ? { kind: 'connected' }
        : onlyRow ? null : { kind: 'picker', switching: false };
      return (
        <div className="p-5 space-y-4">
          {back && (
            <button
              onClick={() => setView(back)}
              className="btn-mini"
            >
              ← Back
            </button>
          )}
          {/* The picker's withheld-backup note, for the form that stands in for
              a one-row picker. No tap chose this form, so it does not read the
              backup on mount; the tap that asks the signer is the button. */}
          {rail === 'nwc' && !picked && backupWithheld && !activeRail && (
            <div className="text-[11px] text-muted border border-bone/15 rounded p-3">
              Your wallet backup was <strong className="text-bone">not</strong> read
              automatically, so that your signer is not asked for it before you
              touch anything. Tap{' '}
              <strong className="text-bone">Restore from Nostr backup</strong> below
              to restore it; your signer will ask once.
            </div>
          )}
          {rail === 'nwc' && (
            <NwcWallet
              mode="form"
              onConnected={() => handleConnected('nwc')}
              autoRestore={picked || !backupWithheld}
            />
          )}
          {rail === 'spark' && (
            <SparkWallet mode="form" onConnected={() => handleConnected('spark')} />
          )}
          {rail === 'webln' && (
            <WeblnWallet mode="form" onConnected={() => handleConnected('webln')} />
          )}
        </div>
      );
    }

    // State 1 (nothing connected) or State 4 (switching)
    const { switching } = view;
    const rows = pickerRows();

    return (
      <div className="p-5 space-y-3">
        {/* A withholding the user cannot otherwise account for. On Amber the
            page-load restore of the Spark seed and the NWC backup is skipped on
            purpose — Amber renders decrypted plaintext in its approval sheet, so
            reading them uninvited puts a SEED PHRASE on screen before the user
            has touched anything. Refusing is right; leaving someone to wonder
            why their wallet did not come back is not, which is why this says so
            here, where they look when it is missing. */}
        {backupWithheld && !activeRail && !sparkAvailable() && (
          <div className="text-[11px] text-muted border border-bone/15 rounded p-3">
            Your wallet backup was <strong className="text-bone">not</strong> read
            automatically, so that your signer is not asked for it before you
            touch anything. Pick <strong className="text-bone">NWC</strong> below to
            restore it; your signer will ask once.
          </div>
        )}
        {backupWithheld && !activeRail && sparkAvailable() && (
          <div className="text-[11px] text-muted border border-bone/15 rounded p-3">
            Your wallet backup was <strong className="text-bone">not</strong> read
            automatically, because Amber shows the decrypted text on screen — and
            for the Spark wallet that text is your seed phrase. To restore it,
            pick <strong className="text-bone">Spark</strong> below and tap{' '}
            <strong className="text-bone">Restore from Nostr</strong>; Amber will
            ask once, and this time you are expecting it.
          </div>
        )}
        {switching && (
          <>
            <button
              onClick={() => setView({ kind: 'connected' })}
              className="btn-mini"
            >
              ← Back
            </button>
            {activeRail && (
              <div className="text-[11px] text-muted border border-bone/15 rounded p-3">
                Tap a connected wallet to make it the active payer. Connecting a
                new wallet will disconnect the others.
              </div>
            )}
          </>
        )}
        <div className="space-y-2">
          {rows.map(({ rail, icon, title, desc }) => {
            const connected = railConnected(rail);
            // Spark encrypts its seed to the user's Nostr key and backs it up to
            // their relays, so it genuinely can't run without an identity — its
            // connect card would dead-end on the same guard. Disable the row with
            // a hint instead. NWC/WebLN work fully signed-out.
            const needsNostr = rail === 'spark' && !identity;
            return (
              <button
                key={rail}
                onClick={() => handlePickerClick(rail, switching)}
                disabled={needsNostr}
                className={`w-full text-left card p-3 transition ${
                  needsNostr ? 'opacity-50 cursor-not-allowed' : 'hover:border-bone/40'
                }`}
              >
                <div className="text-sm font-medium">
                  {icon} {title}
                  {needsNostr && (
                    <span className="ml-2 text-[11px] text-nostr">◆ Sign in with Nostr</span>
                  )}
                  {switching && activeRail === rail && (
                    <span className="ml-2 text-[11px] text-bolt">(active)</span>
                  )}
                  {switching && connected && activeRail !== rail && (
                    <span className="ml-2 text-[11px] text-muted">(connected — tap to switch)</span>
                  )}
                </div>
                <div className="text-xs text-bone/70 mt-0.5">{desc}</div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <ModalShell onClose={onClose} label={headerTitle} className="w-full max-w-md" closeButton>
      <div className="p-5 border-b border-bone/15">
        <div className="stamp text-bolt border-bolt/60 mb-2">⚡ LIGHTNING WALLET</div>
        <h3 className="font-display text-2xl leading-tight">{headerTitle}</h3>
        {headerSub && <p className="text-xs text-muted mt-1">{headerSub}</p>}
      </div>
      {renderBody()}
    </ModalShell>
  );
}
