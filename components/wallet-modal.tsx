'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { hasNwc, subscribeNwc } from '@/lib/v4v/nwc';
import { hasSpark, subscribeSpark } from '@/lib/v4v/spark';
import { hasWebln, isWeblnEnabled, subscribeWebln, weblnEnable } from '@/lib/v4v/webln';
import { clearOtherWallets } from '@/lib/v4v/wallets';
import { recordLastRail } from '@/lib/nostr';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { NwcWallet } from './nwc-wallet';
import { SparkWallet } from './spark-wallet';
import { WeblnWallet } from './webln-wallet';

type WalletView =
  | { kind: 'picker'; switching: boolean }
  | { kind: 'connecting'; rail: 'nwc' | 'spark' | 'webln'; switching: boolean }
  | { kind: 'connected' };

function railConnected(rail: 'nwc' | 'spark' | 'webln'): boolean {
  return rail === 'nwc' ? hasNwc() : rail === 'spark' ? hasSpark() : isWeblnEnabled();
}

// Mirrors pickRail() (rail pref first, then NWC > Spark > WebLN priority)
// but gates WebLN on isWeblnEnabled — inside the wallet UI "active" means
// the user explicitly enabled it, not merely that the extension exists.
function getActiveRail(): 'nwc' | 'spark' | 'webln' | null {
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
  const [view, setView] = useState<WalletView>(() =>
    getActiveRail() !== null ? { kind: 'connected' } : { kind: 'picker', switching: false }
  );
  // Portal target only resolves on the client; tracking it in state lets the
  // first render no-op during SSR and re-render once the body is available.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setPortalTarget(document.body);
    // Sync view when wallet state changes externally (e.g. auto-restore completes
    // after the modal is already open, or a disconnect fires from outside).
    const bump = () => {
      setView((v) => {
        const active = getActiveRail();
        if (v.kind === 'connected' && !active) return { kind: 'picker', switching: false };
        if (v.kind === 'picker' && !v.switching && active) return { kind: 'connected' };
        // Auto-restore completing while the form for that rail is showing:
        // flip straight to connected without requiring the user to re-paste.
        if (v.kind === 'connecting' && active === v.rail) return { kind: 'connected' };
        return v;
      });
    };
    const unsubNwc = subscribeNwc(bump);
    const unsubSpark = subscribeSpark(bump);
    const unsubWebln = subscribeWebln(bump);
    return () => { unsubNwc(); unsubSpark(); unsubWebln(); };
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
  function handlePickerClick(rail: 'nwc' | 'spark' | 'webln', switching: boolean) {
    if (switching && railConnected(rail)) {
      recordLastRail(rail, identity);
      setView({ kind: 'connected' });
      return;
    }
    if (rail === 'webln') { void handleWeblnPickerClick(switching); return; }
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
  const weblnDetected = hasWebln();

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
    headerSub = null;
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
    type PickerRow = { rail: 'nwc' | 'spark' | 'webln'; icon: string; title: string; desc: string };
    const rows: PickerRow[] = [
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
