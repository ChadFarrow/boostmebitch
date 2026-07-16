'use client';

import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import {
  consumeFreshAdoption,
  ensureLibreMounted,
  getLibreMountError,
  getLibreView,
  isLibreBorrowed,
  isLibreMounted,
  isLibreWanted,
  subscribeLibre,
  type LibreView,
} from '@/lib/v4v/libre';
import { clearOtherWallets } from '@/lib/v4v/wallets';
import { LibreMountStatus, LIBRE_MOUNT_OPTS, libreConfigured, libreStatusKind } from './libre-mount';

// Roaming views where the wallet needs the user to DO something, and the widget's own card is the
// only place to do it: blocked by another origin, halted, paused (Drive unreachable), moved to
// another device, wants the recovery phrase, or has no wallet to roam yet. The rest —
// checking / moving / starting / running / stopped — either resolve themselves or are reached via
// the wallet modal, so the card stays out of the way.
const ATTENTION_VIEWS = new Set<LibreView>([
  'blocked',
  'halted',
  'paused',
  'moved-away',
  'need-secret',
  'setup-needed',
]);

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
    //
    // Not after a failure, though: ensureLibreMounted notifies when it settles, which lands right
    // back here — so retrying on its own error would re-fetch the 5 MB chunk in a loop, and clear
    // the very error the card needs to show. Recovery is the explicit "Try again" (retryLibreMount).
    const mountIfWanted = () => {
      if (isLibreWanted() && !getLibreMountError() && slotRef.current) {
        void ensureLibreMounted(slotRef.current, LIBRE_MOUNT_OPTS);
      }
    };
    mountIfWanted();

    // Adopting Libre disconnects the other rails — but ONLY on the transition where it's actually
    // adopted, which `consumeFreshAdoption` reports once. Deriving that here from `isLibreRunning()`
    // is not possible: module state resets to 'stopped' on every load, so a returning user's
    // auto-mount reaching 'running' is indistinguishable from a fresh connect, and clearing on that
    // edge silently deleted the user's NWC URI on every single reload.
    return subscribeLibre(() => {
      mountIfWanted();
      if (consumeFreshAdoption()) {
        void clearOtherWallets('libre', identityRef.current?.npub);
      }
      force((n) => n + 1);
    });
  }, []);

  if (!libreConfigured()) return null;

  // A wallet that's working needs no floating card — it was camping on the page over real content.
  // Show it only when it wants something from you (and never while the modal has it borrowed):
  // a mounted widget in a view that needs an answer, or a mount that failed outright (an adopted
  // user whose bundle 404'd has no other way to find out — the modal's copy only helps if they
  // happen to open it). `loading` deliberately doesn't qualify: a spinner that appears unbidden on
  // every visit is the noise this collapse exists to remove.
  const show =
    !isLibreBorrowed() &&
    (libreStatusKind() === 'error' || (isLibreMounted() && ATTENTION_VIEWS.has(getLibreView())));

  // Collapsed, NOT `display: none`. The widget's spend-approval sheet is a top-layer <dialog>, and
  // the top layer renders nothing under a display:none ancestor — hiding it that way would bring
  // back the hang this whole rail was blocked on. Clipping to a 0×0 box removes the card from the
  // page (top-layer children escape ancestor clipping) while keeping it renderable.
  //
  // It has to be clipping, specifically: the widget sets `:host { all: initial }`, which resets
  // `visibility` and `pointer-events`, so `visibility: hidden` leaves the card fully visible and
  // `opacity: 0` leaves an invisible click-blocker over the page. Both verified in a browser.
  return (
    <div
      className={
        show
          ? 'fixed bottom-3 right-3 z-30 w-[320px] max-w-[calc(100vw-1.5rem)]'
          : 'fixed bottom-0 right-0 z-30 w-0 h-0 overflow-hidden'
      }
      aria-hidden={!show}
    >
      <div ref={slotRef} />
      {show && <LibreMountStatus slot={slotRef} />}
    </div>
  );
}
