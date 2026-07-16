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
import { storage } from '@/lib/storage';
import { LibreMountStatus, LIBRE_MOUNT_OPTS, libreConfigured, libreStatusKind } from './libre-mount';

/**
 * The single, persistent Libre wallet host. Mounted once in the root layout so:
 *  - the in-page LDK node + window.webln provider survive the wallet modal opening/closing and
 *    route changes (the node lives here, not in the modal),
 *  - the Google-Drive OAuth full-page redirect (installed iOS PWA) lands back on a page where the
 *    widget is already mounted to pick up the token from the URL fragment,
 *  - the widget's own running chip stays reachable during a boost, even with the wallet modal shut.
 *
 * The spend-approval sheet does NOT depend on this element's z-index: the widget opens it as a
 * top-layer <dialog>, so it clears the boost modal's z-60 backdrop. It does still depend on this
 * host not being `display: none` — the top layer renders nothing under a hidden ancestor — which is
 * safe because approvals only happen while 'running', and 'running' is never hidden below.
 *
 * It floats bottom-right and hides itself when there's nothing to show (a visitor who never chose
 * Libre) or while the wallet modal has borrowed the element. Without a client id, it no-ops.
 */
export function LibreWalletHost() {
  const slotRef = useRef<HTMLDivElement>(null);
  const identity = useApp((s) => s.identity);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [, force] = useState(0);

  useEffect(() => {
    if (!libreConfigured()) return;
    // Mount only when wanted — an explicit pick, a user who already adopted Libre, or a Drive OAuth
    // redirect landing. Keeps the ~17 MB LDK/WASM bundle off every visitor who never uses Libre.
    const mountIfWanted = () => {
      if (isLibreWanted() && slotRef.current) void ensureLibreMounted(slotRef.current, LIBRE_MOUNT_OPTS);
    };
    mountIfWanted();

    // Adopting Libre disconnects the other rails — but ONLY on the visit where it's adopted.
    // `libreActive` is read once, here, because reaching 'running' sets it before subscribers run,
    // and because module state (`view`) resets to 'stopped' on every page load: a returning user's
    // auto-mount therefore looks identical to a fresh connect at this seam. Clearing on that edge
    // unconditionally silently deleted the user's NWC URI on every single reload.
    const adoptedBeforeThisVisit = storage.libreActive.get();
    let wasRunning = isLibreRunning();
    return subscribeLibre(() => {
      mountIfWanted();
      const nowRunning = isLibreRunning();
      if (nowRunning && !wasRunning && !adoptedBeforeThisVisit) {
        void clearOtherWallets('libre', identityRef.current?.npub);
      }
      wasRunning = nowRunning;
      force((n) => n + 1);
    });
  }, []);

  if (!libreConfigured()) return null;

  // The modal draws the widget itself while it has it borrowed. Otherwise show the card whenever
  // there's something worth showing: a live session, or the loading/error state of one being set up.
  // 'stopped' means the user disconnected (the widget's own reconnect UI is inside the card, but a
  // floating card for a wallet you just turned off is noise — the modal's picker is the way back).
  const idle = !isLibreMounted() && libreStatusKind() === null;
  const hidden = isLibreBorrowed() || idle || getLibreView() === 'stopped';

  return (
    <div
      className="fixed bottom-3 right-3 z-30 w-[320px] max-w-[calc(100vw-1.5rem)]"
      style={{ display: hidden ? 'none' : undefined }}
      aria-hidden={hidden}
    >
      <div ref={slotRef} />
      <LibreMountStatus slot={slotRef} />
    </div>
  );
}
