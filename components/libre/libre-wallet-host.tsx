'use client';

import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import {
  ensureLibreMounted,
  getLibreView,
  isLibreBorrowed,
  isLibreMounted,
  isLibreRunning,
  isLibreWanted,
  subscribeLibre,
} from '@/lib/v4v/libre';
import { clearOtherWallets } from '@/lib/v4v/wallets';

const CLIENT_ID = process.env.NEXT_PUBLIC_LIBRE_GOOGLE_CLIENT_ID;

/**
 * The single, persistent Libre wallet host. Mounted once in the root layout so:
 *  - the in-page LDK node + window.webln provider survive the wallet modal opening/closing and
 *    route changes (the node lives here, not in the modal),
 *  - the Google-Drive OAuth full-page redirect (installed iOS PWA) lands back on a page where the
 *    widget is already mounted to pick up the token from the URL fragment,
 *  - the widget's own spend-approval modal + running chip can surface during a boost even while
 *    the wallet modal is closed.
 *
 * It floats bottom-right and hides itself while the session is fully stopped (nothing to show —
 * a visitor who never chose Libre sees no floating card) or while the wallet modal has borrowed
 * the element (it renders there instead). Absent NEXT_PUBLIC_LIBRE_GOOGLE_CLIENT_ID, it no-ops.
 */
export function LibreWalletHost() {
  const slotRef = useRef<HTMLDivElement>(null);
  const identity = useApp((s) => s.identity);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [, force] = useState(0);

  useEffect(() => {
    if (!CLIENT_ID) return;
    const opts = {
      googleClientId: CLIENT_ID,
      wasmUrl: '/liblightningjs.wasm',
      appName: 'boostmebitch',
      network: 'mainnet' as const,
    };
    // Mount the widget only when wanted — a returning Libre user or a Drive OAuth redirect landing
    // (isLibreWanted), or an explicit pick in the wallet modal (requestLibreMount → subscribeLibre).
    // This keeps the ~17 MB LDK/WASM bundle off every visitor who never uses Libre.
    const mountIfWanted = () => {
      if (isLibreWanted() && slotRef.current) void ensureLibreMounted(slotRef.current, opts);
    };
    mountIfWanted();

    // Re-render so visibility follows state, mount on an explicit pick, and make Libre the active
    // payer the moment it starts running (disconnect the other rails — same effect as picking
    // WebLN; Libre only reaches "running" after an explicit connect, so this never surprises).
    let wasRunning = isLibreRunning();
    return subscribeLibre(() => {
      mountIfWanted();
      const nowRunning = isLibreRunning();
      if (nowRunning && !wasRunning) {
        void clearOtherWallets('webln', identityRef.current?.npub);
      }
      wasRunning = nowRunning;
      force((n) => n + 1);
    });
  }, []);

  if (!CLIENT_ID) return null;

  // Nothing to show until the widget is mounted and the session is past "stopped"; also hidden
  // while the wallet modal has borrowed the element (it renders there instead).
  const hidden = isLibreBorrowed() || !isLibreMounted() || getLibreView() === 'stopped';

  return (
    <div
      ref={slotRef}
      className="fixed bottom-3 right-3 z-30 w-[320px] max-w-[calc(100vw-1.5rem)]"
      style={{ display: hidden ? 'none' : undefined }}
      aria-hidden={hidden}
    />
  );
}
