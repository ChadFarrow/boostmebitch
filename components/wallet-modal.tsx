'use client';

import { useWalletChange } from '@/lib/use-wallet-change';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ModalShell } from './modal-shell';
import { hasNwc } from '@/lib/v4v/nwc-state';
import { hasSpark, sparkAvailable, sparkLastFailure, subscribeSparkFailure } from '@/lib/v4v/spark';
import { hasWebln, isWeblnEnabled, weblnEnable } from '@/lib/v4v/webln';
import {
  borrowLibreElement,
  libreAvailable,
  libreDisconnect,
  libreDisplacedWebln,
  libreHoldsWebln,
  libreSheetOpen,
  isLibreMounted,
  isLibreWanted,
  parkLibreElement,
  requestLibreMount,
  subscribeLibre,
  weblnLive,
} from '@/lib/v4v/libre';
import { clearOtherWallets, type WalletChoice } from '@/lib/v4v/wallets';
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
import { LibreMountStatus } from './libre/libre-mount';

type Rail = 'nwc' | 'spark' | 'webln';

// `picked`: a tap in the picker chose this form. False when the modal opened
// straight on it because the picker would have had one row — that tap is what
// consents to the form's backup read, so without it the read waits for one.
//
// A view names a WalletChoice, not a Rail: the Libre wallet is a choice that
// pays over the WebLN rail (lib/v4v/wallets.ts), so 'libre' has a picker row,
// a view and a title of its own while every payment still goes out as `webln`.
type WalletView =
  | { kind: 'picker'; switching: boolean }
  | { kind: 'connecting'; rail: WalletChoice; switching: boolean; picked: boolean }
  | { kind: 'connected' };

type PickerRow = { rail: WalletChoice; icon: string; title: string; desc: string };

// The rows the picker offers. Read per call, not captured: an extension can
// inject `window.webln` after the modal mounted, and Libre can take it.
function pickerRows(): PickerRow[] {
  // While Libre holds window.webln, `hasWebln()` is Libre — a WebLN row would be
  // a second door to the same wallet. The row comes back only for an extension
  // Libre displaced, which a tap hands window.webln back to.
  const libreHolds = libreHoldsWebln();
  return [
    ...(hasWebln() && (!libreHolds || libreDisplacedWebln())
      ? [{
          rail: 'webln' as const, icon: '◈', title: 'WebLN',
          desc: libreHolds
            ? 'Use the Alby browser extension instead of Libre · tap to switch'
            : 'Use the Alby browser extension · tap to enable',
        }]
      : []),
    // Plain words first, the protocol name second: these three rows are the
    // first thing a newcomer reads about paying, and "NWC · Paste a
    // nostr+walletconnect:// URI" told them nothing about which to pick.
    { rail: 'nwc', icon: '⚡', title: 'NWC', desc: 'Connect a Lightning wallet you already have (Nostr Wallet Connect)' },
    // Not inside the iOS app, which holds no funds (`sparkAvailable`).
    ...(sparkAvailable()
      ? [{ rail: 'spark' as const, icon: '✶', title: 'Spark', desc: 'A wallet this app creates and backs up for you — self-custodial' }]
      : []),
    // Behind the whole gate (`libreAvailable`): a client id, the Boost Me Bitch
    // brand, and not the iOS app. Last, so the rows a newcomer already knew keep
    // their places.
    ...(libreAvailable()
      ? [{ rail: 'libre' as const, icon: '◆', title: 'Libre Wallet', desc: 'Your roaming Lightning wallet — runs in this app' }]
      : []),
  ];
}

/** A heading for a wallet choice. */
function walletTitle(choice: WalletChoice): string {
  return choice === 'nwc' ? 'NWC' : choice === 'spark' ? 'Spark' : choice === 'libre' ? 'Libre Wallet' : 'WebLN';
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

// Is this picker row's wallet the one that would pay? `webln` means the
// EXTENSION here — while Libre holds window.webln, the extension pays nothing.
function railConnected(choice: WalletChoice): boolean {
  if (choice === 'nwc') return hasNwc();
  if (choice === 'spark') return hasSpark();
  if (choice === 'libre') return libreHoldsWebln();
  return isWeblnEnabled() && !libreHoldsWebln();
}

// Mirrors pickRail() (rail pref first, then NWC > Spark > WebLN priority),
// which gates a `webln` pref on `weblnLive()` too (`railWhenUnnamed`,
// lib/util.ts): "active" means enabled in this page load or held by Libre, not
// merely that an extension exists. The one difference is pickRail()'s last
// fallback, which pays from a present-but-not-enabled extension when it is the
// only wallet. A `webln` win while Libre holds window.webln IS Libre, so it is
// shown as the Libre card — whose sign-out stops Libre, which a WebLN card's
// could not (#120, 98786072).
function getActiveRail(): WalletChoice | null {
  const pref = storage.railPref.get();
  const live = (r: Rail) => (r === 'nwc' ? hasNwc() : r === 'spark' ? hasSpark() : weblnLive());
  const rail: Rail | null =
    pref && live(pref) ? pref
      : hasNwc() ? 'nwc'
        : hasSpark() ? 'spark'
          : weblnLive() ? 'webln'
            : null;
  return rail === 'webln' && libreHoldsWebln() ? 'libre' : rail;
}

/**
 * The ONE `<libre-wallet>` element, borrowed from its home in the layout
 * (`<LibreWalletHost>`) for as long as the Libre view shows, and handed back on
 * unmount. The element has no teardown on detach, so the move keeps the
 * session, window.webln and the roaming lease. Borrowed again on every Libre
 * notification, because the modal can open before the package has loaded.
 */
function LibreRailSlot() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const attach = () => { if (ref.current) borrowLibreElement(ref.current); };
    attach();
    const unsub = subscribeLibre(attach);
    return () => { unsub(); parkLibreElement(); };
  }, []);
  return (
    // An Escape inside the borrowed element bubbles (composed) to <ModalShell>,
    // which closes this modal — moving the element under Libre's open approval
    // sheet. The sheet answers that key itself (as a denial), so it stops here.
    <div
      data-libre-slot
      onKeyDown={(e) => { if (e.key === 'Escape' && libreSheetOpen()) e.stopPropagation(); }}
    >
      <div ref={ref} />
      {/* Nothing to borrow until the package lands, and nothing at all if it
          failed: both would be an empty card without this. */}
      <LibreMountStatus slot={ref} />
    </div>
  );
}

interface Props {
  onClose: () => void;
}

export function WalletModal({ onClose }: Props) {
  const identity = useApp((s) => s.identity);
  // A Spark wallet the page-load restore could not open: the picker is the
  // first thing the person sees, so its row says so and the form says why (#304).
  const sparkDidNotOpen = useSyncExternalStore(subscribeSparkFailure, sparkLastFailure, () => null)?.op === 'connect';
  const backupWithheld = useApp((s) => s.walletBackupWithheld);
  const [view, setView] = useState<WalletView>(firstView);
  // A Libre change can move what renders without moving `view` — Libre taking
  // window.webln hides the WebLN row and renames the active card — and a
  // `setView` that returns the same view renders nothing.
  const [, rerender] = useState(0);
  // Sync view when wallet state changes externally (e.g. auto-restore completes
  // after the modal is already open, a disconnect fires from outside, or the
  // Libre widget reaches "running" through its own connect button).
  useWalletChange(() => {
    rerender((n) => n + 1);
    setView((v) => {
      const active = getActiveRail();
      // Libre roaming away (paused, moved-away, need-secret) stops it holding
      // window.webln, so nothing is "active" — but the widget is where its
      // answer is. Keep its slot rather than park it under this modal, where
      // the host card would show behind the backdrop.
      if (v.kind === 'connected' && !active && isLibreMounted() && isLibreWanted()) {
        return { kind: 'connecting', rail: 'libre', switching: false, picked: true };
      }
      if (v.kind === 'connected' && !active) return firstView();
      if (v.kind === 'picker' && !v.switching && active) return { kind: 'connected' };
      // Auto-restore completing while the form for that rail is showing:
      // flip straight to connected without requiring the user to re-paste.
      if (v.kind === 'connecting' && active === v.rail) return { kind: 'connected' };
      return v;
    });
  });


  async function handleConnected(rail: Rail, opts?: { keepOpen?: boolean }) {
    await clearOtherWallets(rail, identity?.npub);
    // A connect that worked but left the card something to say — Spark's pasted
    // seed whose backup reached no relay — stays open on that card. The other
    // rails are cleared either way: this IS the new wallet.
    if (opts?.keepOpen) { setView({ kind: 'connected' }); return; }
    onClose();
  }

  // Tapping an ALREADY-CONNECTED rail in the switch picker makes it the
  // active payer (rail pref → pickRail / balance chip / menu summary follow)
  // without touching the other connections. Only connecting a NEW wallet
  // disconnects the others (clearOtherWallets in handleConnected).
  //
  // Libre pays over the WebLN rail, so tapping it records `webln` — which
  // `weblnLive()` lets win in pickRail(), the chip and this modal alike.
  function handlePickerClick(rail: WalletChoice, switching: boolean) {
    if (switching && railConnected(rail)) {
      recordLastRail(rail === 'libre' ? 'webln' : rail, identity);
      setView({ kind: 'connected' });
      return;
    }
    if (rail === 'webln') { void handleWeblnPickerClick(switching); return; }
    // The widget draws its own connect UI in the borrowed slot; this only asks
    // the host to load and mount it (idempotent, and a no-op behind the gate).
    if (rail === 'libre') requestLibreMount();
    setView({ kind: 'connecting', rail, switching, picked: true });
  }

  async function handleWeblnPickerClick(switching: boolean) {
    // WebLN has only one action — skip the form, enable inline, close on success.
    try {
      // The row is offered over a running Libre only for the extension it
      // displaced. Hand window.webln back FIRST: `weblnEnable()` asks whatever
      // window.webln holds, and that would be Libre's approval sheet, not the
      // extension the row names.
      if (libreHoldsWebln()) await libreDisconnect();
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
    headerTitle = activeRail ? walletTitle(activeRail) : 'Lightning Wallet';
    headerSub = null;
  } else if (view.kind === 'connecting') {
    headerTitle = walletTitle(view.rail);
    // No picker row explained this rail, so the header does.
    headerSub = view.picked ? null : onlyRow?.desc ?? null;
  } else if (view.kind === 'picker' && view.switching) {
    headerTitle = 'Switch wallet';
    headerSub = null;
  }

  function renderBody() {
    // Libre draws its own connect and running UI inside the borrowed element, so
    // connecting and connected show the same slot — under one key, so the flip
    // between them does not remount it (a park and a re-borrow: a flicker).
    const libreFocused =
      (view.kind === 'connecting' && view.rail === 'libre') ||
      (view.kind === 'connected' && activeRail === 'libre');
    if (libreFocused) {
      const back: WalletView | null = view.kind !== 'connecting'
        ? null
        : view.switching ? { kind: 'connected' } : onlyRow ? null : { kind: 'picker', switching: false };
      return (
        <div className="p-5 space-y-4">
          {back && (
            <button key="back" onClick={() => setView(back)} className="btn-mini">
              ← Back
            </button>
          )}
          <LibreRailSlot key="libre-slot" />
          {view.kind === 'connected' && (
            <>
              <div className="border-t border-bone/15 pt-4">
                <DefaultAmounts />
              </div>
              {/* In place of <StreamRate>: streaming refuses this wallet
                  (`unattendedRailRefusal`, docs/streaming.md "A payer that can
                  ask"), so a rate control here would only arm a refusal. */}
              <p className="border-t border-bone/15 pt-4 text-[11px] text-muted" data-libre-no-stream>
                Streaming sats does not pay from Libre: Libre can stop a payment
                to ask you first, and streaming pays with nobody watching.
                Boosts pay from Libre as usual.
              </p>
              <div className="border-t border-bone/15 pt-3 flex flex-wrap items-center justify-between gap-3">
                {!onlyRow && (
                  <button onClick={() => setView({ kind: 'picker', switching: true })} className="btn-mini">
                    Switch wallet →
                  </button>
                )}
                {/* Not the widget's own Disconnect, which stops the session and
                    leaves Libre this browser's wallet: this also forgets the
                    adoption (bmb:libre_active), so later visits stop loading the
                    package. It keeps the wallet on this device. */}
                <button
                  onClick={() => { void libreDisconnect().then(() => setView(firstView())); }}
                  className="btn-mini"
                  title="Signs out and releases the wallet, but keeps it on this device, so you can come back without your recovery phrase."
                >
                  Sign out (keep wallet here)
                </button>
              </div>
            </>
          )}
        </div>
      );
    }

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
            <SparkWallet mode="form" onConnected={(o) => handleConnected('spark', o)} />
          )}
          {rail === 'webln' && (
            <WeblnWallet mode="form" onConnected={() => handleConnected('webln')} />
          )}
          {/* 'libre' never reaches here: `libreFocused` above renders it. */}
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
                  {rail === 'spark' && !needsNostr && !connected && sparkDidNotOpen && (
                    <span className="ml-2 text-[11px] text-nostr" data-spark-did-not-open>did not open · tap for why</span>
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
