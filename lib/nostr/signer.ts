'use client';

// Centralized control over which signer the rest of the app sees.
//
// The whole codebase (publish.ts, mutes.ts, wallet-backup.ts, zap.ts, auth.ts)
// reads from `window.nostr`. To avoid touching every call site we polyfill
// `window.nostr` with the AmberSigner when the user has chosen Amber, and
// restore the original (a NIP-07 extension, if any) on sign-out.
//
// This module owns the swap. Callers should use:
//   activateAmberSigner(pubkey?)  — install AmberSigner as window.nostr
//   deactivateAmberSigner()       — restore the original window.nostr
//   isAmberActive()               — true while AmberSigner is the active signer

import { AmberSigner } from './amber';

let amberInstance: AmberSigner | null = null;
// Captured once on first activation per page. We don't recapture on
// re-activation because window.nostr would already be our AmberSigner — the
// "original" we want to restore is the underlying extension, not ourselves.
let originalWindowNostr: Window['nostr'] | undefined;
let originalCaptured = false;

export function activateAmberSigner(pubkey?: string): AmberSigner {
  if (typeof window === 'undefined') {
    throw new Error('Amber signer requires a browser environment');
  }
  if (!originalCaptured) {
    originalWindowNostr = window.nostr;
    originalCaptured = true;
  }
  amberInstance = new AmberSigner(pubkey);
  // Cast: AmberSigner satisfies the structural shape declared in auth.ts.
  window.nostr = amberInstance as unknown as Window['nostr'];
  return amberInstance;
}

export function deactivateAmberSigner() {
  if (typeof window === 'undefined') return;
  amberInstance = null;
  if (originalCaptured) {
    window.nostr = originalWindowNostr;
  }
}

export function isAmberActive(): boolean {
  return amberInstance !== null;
}

export function getActiveAmber(): AmberSigner | null {
  return amberInstance;
}
