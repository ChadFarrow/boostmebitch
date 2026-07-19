'use client';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { subscribeNwc } from '@/lib/v4v/nwc';
import { subscribeSpark } from '@/lib/v4v/spark';
import { subscribeWebln } from '@/lib/v4v/webln';
import { subscribeRailPref } from '@/lib/storage';
import { hasAnyWallet } from '@/lib/v4v/wallets';
import { WalletModal } from './wallet-modal';
import { WalletBalanceChip } from './wallet-balance';

// The header auth control — one entry point for two independent logins.
// Lightning (wallet) and Nostr are separate: a wallet connects without any
// Nostr identity. This component renders:
//   • the wallet balance chip inline once a wallet is connected (opens the
//     wallet modal),
//   • a single "Sign in ▾" dropdown listing both options when NOTHING is
//     connected, or a direct button for whichever one remains,
//   • nothing (delegating to <NostrAuth>'s AccountMenu) once both are set.
// The Nostr account menu itself is still owned/rendered by <NostrAuth>, which
// sits right after this in the header; both modals' open-state lives in the
// store (walletOpen / signInOpen) so triggering either from here just flips a
// flag. <WalletModal> is owned here.
export function AuthControl() {
  const identity = useApp((s) => s.identity);
  const walletOpen = useApp((s) => s.walletOpen);
  const setWalletOpen = useApp((s) => s.setWalletOpen);
  const setSignInOpen = useApp((s) => s.setSignInOpen);
  const [, setTick] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // Wallet state is read from localStorage (hasAnyWallet), which the server
  // can't see — so gate it behind mount. Without this, SSR renders the
  // signed-out "Sign in" control while the client's first render sees the
  // connected wallet, a hydration mismatch that made React discard and
  // regenerate the whole header subtree on every load. First client render now
  // matches SSR; the real wallet state paints one tick later.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Re-render on rail-state changes so the control flips between the
  // "Sign in" affordance and the connected chip without a remount.
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const unsubNwc = subscribeNwc(bump);
    const unsubSpark = subscribeSpark(bump);
    const unsubWebln = subscribeWebln(bump);
    const unsubPref = subscribeRailPref(bump);
    return () => { unsubNwc(); unsubSpark(); unsubWebln(); unsubPref(); };
  }, []);

  // Dismiss the dropdown on outside-click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const walletConnected = mounted && hasAnyWallet();
  const needNostr = !identity;

  return (
    <div ref={wrapperRef} className="relative flex items-center gap-2">
      {walletConnected && (
        <button
          onClick={() => setWalletOpen(true)}
          className="btn-ghost flex items-center gap-2"
          aria-label="Manage Lightning wallet"
        >
          <span className="text-bolt">⚡</span>
          {/* Renders null until a balance is known (or for rails that expose
              none, e.g. WebLN) — the lit ⚡ still reads as "connected". */}
          <WalletBalanceChip />
        </button>
      )}

      {/* Nothing connected → one combined dropdown with both logins. */}
      {!walletConnected && needNostr && (
        <>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="btn-ghost flex items-center gap-1"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span>Sign in</span>
            <span className="opacity-50 text-[10px]">{menuOpen ? '▴' : '▾'}</span>
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-2 w-60 card bg-ink p-2 z-40 shadow-xl"
            >
              <button
                role="menuitem"
                onClick={() => { setMenuOpen(false); setWalletOpen(true); }}
                className="w-full text-left px-3 py-2 rounded hover:bg-bone/5 transition flex items-center gap-2 text-sm"
              >
                <span className="text-bolt">⚡</span>
                <span className="flex flex-col">
                  <span>Connect wallet</span>
                  <span className="text-[11px] text-muted">Boost with Lightning — no Nostr needed</span>
                </span>
              </button>
              <button
                role="menuitem"
                onClick={() => { setMenuOpen(false); setSignInOpen(true); }}
                className="w-full text-left px-3 py-2 rounded hover:bg-bone/5 transition flex items-center gap-2 text-sm"
              >
                <span className="text-nostr">◆</span>
                <span className="flex flex-col">
                  <span>Sign in with Nostr</span>
                  <span className="text-[11px] text-muted">Notes, favorites, cross-device sync</span>
                </span>
              </button>
            </div>
          )}
        </>
      )}

      {/* Only the wallet is missing → direct connect button. */}
      {!walletConnected && !needNostr && (
        <button
          onClick={() => setWalletOpen(true)}
          className="btn-ghost flex items-center gap-2"
          aria-label="Connect Lightning wallet"
        >
          <span className="text-muted">⚡</span>
          <span className="hidden sm:inline">Connect wallet</span>
        </button>
      )}

      {/* Only Nostr is missing → direct sign-in button. */}
      {walletConnected && needNostr && (
        <button
          onClick={() => setSignInOpen(true)}
          className="btn-ghost flex items-center gap-2"
        >
          <span className="text-nostr">◆</span>
          <span className="hidden sm:inline">Sign in</span>
        </button>
      )}

      {walletOpen && <WalletModal onClose={() => setWalletOpen(false)} />}
    </div>
  );
}
