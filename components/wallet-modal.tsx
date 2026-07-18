'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { hasNwc, subscribeNwc } from '@/lib/v4v/nwc';
import { hasSpark, subscribeSpark } from '@/lib/v4v/spark';
import { hasWebln, isWeblnEnabled, subscribeWebln, weblnEnable } from '@/lib/v4v/webln';
import {
  borrowLibreElement,
  isLibreRunning,
  libreDisconnect,
  parkLibreElement,
  requestLibreMount,
  subscribeLibre,
  switchLibreDriveAccount,
} from '@/lib/v4v/libre';
import { clearOtherWallets, railLabel, type WalletChoice } from '@/lib/v4v/wallets';
import { recordLastRail } from '@/lib/nostr';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { LibreMountStatus, libreConfigured } from './libre/libre-mount';
import { NwcWallet } from './nwc-wallet';
import { SparkWallet } from './spark-wallet';
import { WeblnWallet } from './webln-wallet';

// The Libre rail exists only where its OAuth client id is baked in (else the widget can't mount —
// see components/libre/libre-mount.tsx), so we hide the picker card without it.
const LIBRE_AVAILABLE = libreConfigured();

// The set of wallets the picker offers is WalletChoice (lib/v4v/wallets.ts) — Rail plus 'libre',
// which fronts window.webln rather than being a rail of its own, so boosts keep flowing through the
// existing WebLN path in lib/v4v/boost.ts with no changes there.
type WalletView =
  | { kind: 'picker'; switching: boolean }
  | { kind: 'connecting'; rail: WalletChoice; switching: boolean }
  | { kind: 'connected' };

/** Modal-side title for a wallet. `railLabel` covers the rails (and renames 'webln' → "Libre" while
 *  Libre owns it); 'libre' isn't a Rail, and reads long-form here because it's a heading. */
function walletTitle(choice: WalletChoice): string {
  return choice === 'libre' ? 'Libre Wallet' : railLabel(choice);
}

function railConnected(rail: WalletChoice): boolean {
  return rail === 'nwc' ? hasNwc()
    : rail === 'spark' ? hasSpark()
    : rail === 'libre' ? isLibreRunning()
    : isWeblnEnabled();
}

// Mirrors pickRail() (rail pref first, then NWC > Spark > WebLN priority)
// but gates WebLN on isWeblnEnabled — inside the wallet UI "active" means
// the user explicitly enabled it, not merely that the extension exists.
function getActiveRail(): WalletChoice | null {
  // Libre outranks the stored pref, because while it runs it IS window.webln — it isn't one
  // candidate among several. Checking the pref first got this backwards the moment you boosted:
  // paying via Libre goes through the WebLN rail, so recordLastRail writes pref='webln' and
  // ensureWebln flips weblnEnabled on — and from then on this returned 'webln', quietly replacing
  // the Libre card with a WebLN one whose Disconnect can't stop Libre at all.
  if (isLibreRunning()) return 'libre';
  const pref = storage.railPref.get();
  if (pref && railConnected(pref)) return pref;
  if (hasNwc()) return 'nwc';
  if (hasSpark()) return 'spark';
  if (isWeblnEnabled()) return 'webln';
  return null;
}

// Reparents the single persistent <libre-wallet> element (mounted in the layout) into the modal
// while the Libre rail is shown, and returns it to its floating home slot on unmount. The element
// has no teardown-on-detach, so the move preserves the session / window.webln / roaming lease.
function LibreRailSlot() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Borrow now if the widget is already mounted, or as soon as it finishes its dynamic import
    // (the modal can open before the LDK/WASM bundle has loaded). borrowLibreElement no-ops until
    // the element exists and only notifies on the first borrow, so re-calling it is safe.
    const attach = () => { if (ref.current) borrowLibreElement(ref.current); };
    attach();
    const unsub = subscribeLibre(attach);
    return () => { unsub(); parkLibreElement(); };
  }, []);
  return (
    <div>
      <div ref={ref} />
      {/* There's no element to borrow until the bundle lands — and none at all if it failed. Both
          look identical without this: an empty card the user can only stare at. */}
      <LibreMountStatus slot={ref} />
    </div>
  );
}

interface Props {
  onClose: () => void;
}

export function WalletModal({ onClose }: Props) {
  const identity = useApp((s) => s.identity);
  const [view, setView] = useState<WalletView>(() =>
    getActiveRail() !== null ? { kind: 'connected' } : { kind: 'picker', switching: false }
  );
  // Portal target only resolves on the client; tracking it in state lets the
  // first render no-op during SSR and re-render once the body is available.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  // Force a re-render on rail-state changes that don't change `view` (e.g. Libre starts running
  // while the picker is open — the WebLN card must hide, the Libre card flip to connected).
  const [, force] = useState(0);

  useEffect(() => {
    setPortalTarget(document.body);
    // Sync view when wallet state changes externally (e.g. auto-restore completes
    // after the modal is already open, a disconnect fires from outside, or the Libre
    // widget reaches "running" via its own connect button).
    const bump = () => {
      force((n) => n + 1);
      setView((v) => {
        const active = getActiveRail();
        if (v.kind === 'connected' && !active) return { kind: 'picker', switching: false };
        if (v.kind === 'picker' && !v.switching && active) return { kind: 'connected' };
        // Auto-restore/connect completing while the form for that rail is showing:
        // flip straight to connected without requiring the user to re-paste.
        if (v.kind === 'connecting' && active === v.rail) return { kind: 'connected' };
        return v;
      });
    };
    const unsubNwc = subscribeNwc(bump);
    const unsubSpark = subscribeSpark(bump);
    const unsubWebln = subscribeWebln(bump);
    const unsubLibre = subscribeLibre(bump);
    return () => { unsubNwc(); unsubSpark(); unsubWebln(); unsubLibre(); };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleConnected(rail: 'nwc' | 'spark' | 'webln') {
    await clearOtherWallets(rail, identity?.npub);
    onClose();
  }

  // Tapping an ALREADY-CONNECTED rail in the switch picker makes it the
  // active payer (rail pref → pickRail / balance chip / menu summary follow)
  // without touching the other connections. Only connecting a NEW wallet
  // disconnects the others (clearOtherWallets in handleConnected).
  function handlePickerClick(rail: WalletChoice, switching: boolean) {
    if (switching && railConnected(rail)) {
      // Libre isn't persisted in railPref (it fronts window.webln); tapping it just re-focuses.
      if (rail !== 'libre') recordLastRail(rail, identity);
      setView({ kind: 'connected' });
      return;
    }
    if (rail === 'webln') { void handleWeblnPickerClick(switching); return; }
    // 'libre': ask the host to load + mount the widget (idempotent); it draws its own connect UI
    // in the reparented slot. nwc/spark just show the connecting form.
    if (rail === 'libre') requestLibreMount();
    setView({ kind: 'connecting', rail, switching });
  }

  async function handleWeblnPickerClick(switching: boolean) {
    // WebLN has only one action — skip the form, enable inline, close on success.
    try {
      await weblnEnable();
      await clearOtherWallets('webln', identity?.npub);
      onClose();
    } catch {
      // Enable failed (user denied) — fall back to the form so they see the error.
      setView({ kind: 'connecting', rail: 'webln', switching });
    }
  }

  function handleDisconnected() {
    setView({ kind: 'picker', switching: false });
  }

  // Portal to body so `position: fixed` resolves against the viewport, not the
  // sticky <header>. The header uses `backdrop-blur` which creates a containing
  // block for fixed descendants per CSS spec.
  if (!portalTarget) return null;

  const activeRail = getActiveRail();
  // Libre fronts window.webln once running, so hasWebln() would light up the WebLN card as a
  // second door to the same wallet — hide it while Libre is the active provider.
  const weblnDetected = hasWebln() && !isLibreRunning();

  let headerTitle = 'Connect a wallet';
  let headerSub: string | null = 'Pick one to send Lightning payments.';
  if (view.kind === 'connected') {
    headerTitle = activeRail ? walletTitle(activeRail) : 'Lightning Wallet';
    headerSub = null;
  } else if (view.kind === 'connecting') {
    headerTitle = walletTitle(view.rail);
    headerSub = null;
  } else if (view.kind === 'picker' && view.switching) {
    headerTitle = 'Switch wallet';
    headerSub = null;
  }

  function renderBody() {
    // Libre draws its own connect + running UI inside the reparented widget element, so both the
    // connecting and connected states show the same single slot — keyed so the connecting→connected
    // flip doesn't remount it (which would park + re-borrow the element and flicker it).
    const libreFocused =
      (view.kind === 'connecting' && view.rail === 'libre') ||
      (view.kind === 'connected' && activeRail === 'libre');
    if (libreFocused) {
      const showBack = view.kind === 'connecting';
      const back: WalletView =
        view.kind === 'connecting' && view.switching
          ? { kind: 'connected' }
          : { kind: 'picker', switching: false };
      return (
        <div className="p-5 space-y-4">
          {showBack && (
            <button
              key="back"
              onClick={() => setView(back)}
              className="text-[11px] text-muted hover:text-bone"
            >
              ← Back
            </button>
          )}
          <LibreRailSlot key="libre-slot" />
          {view.kind === 'connected' && (
            <div className="border-t border-bone/15 pt-3 space-y-3">
              <div className="flex items-center justify-between">
                <button
                  onClick={() => setView({ kind: 'picker', switching: true })}
                  className="text-[11px] text-muted hover:text-bone"
                >
                  Switch wallet →
                </button>
                {/* NOT a duplicate of the widget's own "Disconnect" (which sits inside the card and
                    just stops the session, leaving Libre this browser's wallet). This forgets the
                    adoption too, so later visits stop pulling the ~17 MB LDK bundle. Labelled for the
                    difference — two buttons reading "Disconnect" side by side is a coin toss. */}
                <button
                  onClick={() => { void libreDisconnect().then(() => setView({ kind: 'picker', switching: false })); }}
                  className="text-[11px] text-muted hover:text-nostr"
                >
                  Stop using Libre here
                </button>
              </div>
              {/* Keeps Libre adopted — just forgets which Google account it's bound to so the next
                  connect shows Google's chooser. Reloads because the package caches the OAuth token
                  for the page's life; see switchLibreDriveAccount. */}
              <button
                onClick={() => switchLibreDriveAccount()}
                className="w-full text-[11px] text-muted hover:text-bone text-center"
              >
                Switch Google account
              </button>
            </div>
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
          <div className="border-t border-bone/15 pt-3 text-center">
            <button
              onClick={() => setView({ kind: 'picker', switching: true })}
              className="text-[11px] text-muted hover:text-bone"
            >
              Switch wallet →
            </button>
          </div>
        </div>
      );
    }

    if (view.kind === 'connecting') {
      const { rail, switching } = view;
      const back: WalletView = switching
        ? { kind: 'connected' }
        : { kind: 'picker', switching: false };
      return (
        <div className="p-5 space-y-4">
          <button
            onClick={() => setView(back)}
            className="text-[11px] text-muted hover:text-bone"
          >
            ← Back
          </button>
          {rail === 'nwc' && (
            <NwcWallet mode="form" onConnected={() => handleConnected('nwc')} />
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
    type PickerRow = { rail: WalletChoice; icon: string; title: string; desc: string };
    const rows: PickerRow[] = [
      ...(LIBRE_AVAILABLE
        ? [{ rail: 'libre' as const, icon: '◆', title: 'Libre Wallet', desc: 'Your roaming Lightning wallet — runs in this app' }]
        : []),
      { rail: 'nwc', icon: '⚡', title: 'NWC', desc: 'Paste a nostr+walletconnect:// URI' },
      { rail: 'spark', icon: '✶', title: 'Spark', desc: 'Self-custodial, create or restore' },
      ...(weblnDetected
        ? [{ rail: 'webln' as const, icon: '◈', title: 'WebLN', desc: 'Alby extension · tap to enable' }]
        : []),
    ];

    return (
      <div className="p-5 space-y-3">
        {switching && (
          <>
            <button
              onClick={() => setView({ kind: 'connected' })}
              className="text-[11px] text-muted hover:text-bone"
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
            return (
              <button
                key={rail}
                onClick={() => handlePickerClick(rail, switching)}
                className="w-full text-left card p-3 hover:border-bone/40 transition"
              >
                <div className="text-sm font-medium">
                  {icon} {title}
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

  return createPortal(
    <div className="fixed inset-0 z-40 bg-ink/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="card w-full max-w-md bg-ink relative max-h-[92vh] overflow-y-auto">
        <button
          onClick={onClose}
          className="absolute top-2 right-3 text-muted hover:text-bone text-lg z-10"
          aria-label="Close"
        >
          ×
        </button>
        <div className="p-5 border-b border-bone/15">
          <div className="stamp text-bolt border-bolt/60 mb-2">⚡ LIGHTNING WALLET</div>
          <h3 className="font-display text-2xl leading-tight">{headerTitle}</h3>
          {headerSub && <p className="text-xs text-muted mt-1">{headerSub}</p>}
        </div>
        {renderBody()}
      </div>
    </div>,
    portalTarget,
  );
}
