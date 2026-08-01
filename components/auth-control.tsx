'use client';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { subscribeNwc } from '@/lib/v4v/nwc';
import { subscribeSpark } from '@/lib/v4v/spark';
import { subscribeWebln } from '@/lib/v4v/webln';
import { subscribeRailPref } from '@/lib/storage';
import { isGoogleAuthConfigured } from '@/lib/nostr/google-auth';
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
  const walletRestoring = useApp((s) => s.walletRestoring);
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
  // Reads an inlined NEXT_PUBLIC_* var, so it's identical on server and client —
  // no `mounted` gate needed, unlike walletConnected (which reads localStorage).
  const googleConfigured = isGoogleAuthConfigured();

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
              {/* Order: the two Nostr-identity options first (Nostr proper, then
                  Google, which also ends in a Nostr identity — it just mints the
                  key for you), wallet last since it's a different axis entirely:
                  Lightning with no identity at all. */}
              <button
                role="menuitem"
                onClick={() => { setMenuOpen(false); setSignInOpen(true); }}
                className="w-full text-left px-3 py-2 rounded hover:bg-bone/5 transition flex items-start gap-2 text-sm"
              >
                {/* Fixed-width, centred glyph column: ◆ / ◉ / ⚡ have different
                    advance widths (⚡ is an emoji and widest), so without it the
                    three labels start at three different x positions. leading-5
                    matches text-sm's line box, so items-start lands the glyph on
                    the TITLE's line rather than centring it against the whole
                    two-line block — which is what put it beside the subtitle. */}
                <span className="text-nostr w-4 shrink-0 text-center leading-5">◆</span>
                <span className="flex flex-col">
                  <span>Sign in with Nostr</span>
                  {/* Names the prerequisite rather than the benefit. The benefits
                      ("notes, favorites, sync") are identical to the Google
                      option's, so leading with them gave no basis to choose. */}
                  <span className="text-[11px] text-muted">Already have a key — extension or signer</span>
                </span>
              </button>
              {/* A peer of the option above, not a detail inside it. This used to
                  live only INSIDE the sign-in modal, which meant the people it
                  exists for had to first pick "Sign in with Nostr" to reach the
                  thing that exists precisely because they don't have Nostr. */}
              {googleConfigured && (
                <button
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); setSignInOpen(true, 'google'); }}
                  className="w-full text-left px-3 py-2 rounded hover:bg-bone/5 transition flex items-start gap-2 text-sm"
                >
                  <span className="text-bone w-4 shrink-0 text-center leading-5">◉</span>
                  <span className="flex flex-col">
                    <span>Continue with Google</span>
                    <span className="text-[11px] text-muted">New here? Creates an account for you</span>
                  </span>
                </button>
              )}
              <button
                role="menuitem"
                onClick={() => { setMenuOpen(false); setWalletOpen(true); }}
                className="w-full text-left px-3 py-2 rounded hover:bg-bone/5 transition flex items-start gap-2 text-sm"
              >
                <span className="text-bolt w-4 shrink-0 text-center leading-5">⚡</span>
                <span className="flex flex-col">
                  <span>Connect wallet</span>
                  <span className="text-[11px] text-muted">Boost with Lightning — no Nostr needed</span>
                </span>
              </button>
            </div>
          )}
        </>
      )}

      {/* Only the wallet is missing → direct connect button, UNLESS one is
          already on its way back up. hasAnyWallet() is false for the whole
          Spark SDK-import + operator-handshake window on a cold load, so
          without this the header spends those seconds inviting the user to
          connect a wallet they already have. Still opens the modal on tap —
          it's a status label, not a lock. */}
      {!walletConnected && !needNostr && (
        <button
          onClick={() => setWalletOpen(true)}
          className="btn-ghost flex items-center gap-2"
          aria-label={walletRestoring ? 'Wallet connecting' : 'Connect Lightning wallet'}
        >
          <span className={walletRestoring ? 'text-bolt animate-bolt' : 'text-muted'}>⚡</span>
          <span className="hidden sm:inline">
            {walletRestoring ? 'connecting…' : 'Connect wallet'}
          </span>
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
