'use client';

// Wallet-modal sub-card for the Libre embedded wallet. Same { mode,
// onConnected?, onDisconnected? } contract as webln-wallet.tsx. This
// component NEVER mounts the widget itself — <LibreWalletHost> (layout)
// owns the dock; this card only drives the opt-in and reflects state.
//
// Connect sequencing is redirect-safe on purpose: clearOtherWallets +
// libreOptIn + recordLastRail all run at the Enable click, BEFORE the user
// touches the widget's Google sign-in — a full-page OAuth redirect destroys
// this page instance, so nothing can be deferred to a "connected" callback.
// A rail pref pointing at a not-yet-running rail is harmless (a pref only
// wins where the rail is actually connected).

import { useEffect, useRef, useState } from 'react';
import { getErrorMessage } from '@/lib/util';
import {
  getLibreView,
  hasLibre,
  isLibreRunning,
  libreDisconnect,
  libreOptIn,
  subscribeLibre,
} from '@/lib/v4v/libre';
import { clearOtherWallets } from '@/lib/v4v/wallets';
import { recordLastRail } from '@/lib/nostr';
import { useApp } from '@/lib/store';

interface Props {
  mode: 'form' | 'card';
  onConnected?: () => void;
  onDisconnected?: () => void;
}

function statusCopy(): string {
  switch (getLibreView()) {
    case 'running':
      return 'Running in this page — boosts settle through it, even on iOS.';
    case 'moved-away':
      return 'Active on another tab or site. Use “Move wallet here” in the widget (bottom-right) to bring it back.';
    case 'stopped':
      return 'Not running. Open the widget at the bottom-right and sign in with Google to start it.';
    default:
      return 'Starting the widget…';
  }
}

export function LibreWallet({ mode, onConnected, onDisconnected }: Props) {
  const identity = useApp((s) => s.identity);
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Fires onConnected at most once per mount, when the widget first reports
  // running after the user enabled the rail here.
  const announcedRunning = useRef(false);

  useEffect(() => {
    const bump = () => {
      setTick((t) => t + 1);
      if (mode === 'form' && isLibreRunning() && !announcedRunning.current) {
        announcedRunning.current = true;
        onConnected?.();
      }
    };
    return subscribeLibre(bump);
    // onConnected comes from the wallet modal and is stable per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const optedIn = hasLibre();

  async function enable() {
    setErr(null);
    setBusy(true);
    try {
      // Order matters: settle the one-active-wallet contract before the user
      // can leave the page via the Google redirect.
      await clearOtherWallets('libre', identity?.npub);
      libreOptIn();
      recordLastRail('libre', identity);
    } catch (e) {
      setErr(getErrorMessage(e, 'could not enable Libre Wallet'));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await libreDisconnect();
      onDisconnected?.();
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'card') {
    if (!optedIn) return null;
    return (
      <div className="space-y-2">
        <div className="text-[11px] text-muted">{statusCopy()}</div>
        <button
          onClick={disconnect}
          disabled={busy}
          className="text-[11px] text-muted hover:text-nostr disabled:opacity-30"
        >
          {busy ? 'Disconnecting…' : 'Disconnect'}
        </button>
      </div>
    );
  }

  // mode === 'form'
  if (optedIn) {
    return (
      <div className="space-y-2">
        <div className="text-xs text-bone/70 leading-relaxed">{statusCopy()}</div>
        <div className="text-[11px] text-muted leading-relaxed">
          Sign in with Google in the widget — your encrypted wallet backup
          lives in your own Drive. First time here, you’ll enter your recovery
          phrase once to roam the wallet in.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-xs text-bone/70 leading-relaxed">
        Runs your Libre Lightning wallet inside this page — the same wallet as
        the Libre app, roamed here. Because it runs in the foreground, boosts
        settle reliably on iOS.
      </div>
      <button onClick={enable} disabled={busy} className="btn-ghost disabled:opacity-30">
        {busy ? 'Enabling…' : 'Enable Libre Wallet'}
      </button>
      <div className="text-[11px] text-muted leading-relaxed">
        Connecting disconnects other wallets. No wallet yet? Create and back
        one up in the standalone Libre wallet app first, then connect it here.
      </div>
      {err && <div className="text-[11px] text-nostr/80">{err}</div>}
    </div>
  );
}
