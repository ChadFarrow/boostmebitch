'use client';

// Centralized control over which signer the rest of the app sees.
//
// The whole codebase (publish.ts, mutes.ts, wallet-backup.ts, zap.ts, auth.ts)
// reads from `window.nostr`. To avoid touching every call site we polyfill
// `window.nostr` with the active signer (AmberSigner for NIP-55, a NIP-46
// BunkerAdapter for remote signers) and restore the original (a NIP-07
// extension, if any) on sign-out.
//
// This module owns the swap. Callers should use:
//   activateAmberSigner(pubkey?)   — install AmberSigner as window.nostr
//   deactivateAmberSigner()        — restore the original window.nostr
//   isAmberActive()                — true while AmberSigner is active
//   activateBunkerSigner(adapter)  — install NIP-46 adapter as window.nostr
//   deactivateBunkerSigner()       — restore the original window.nostr
//   isBunkerActive()               — true while bunker adapter is active

import { AmberSigner } from './amber';
import type { BunkerAdapter } from './bunker';

let amberInstance: AmberSigner | null = null;
let bunkerInstance: BunkerAdapter | null = null;
// Captured once on first activation per page. We don't recapture on
// re-activation because window.nostr would already be one of our polyfills
// — the "original" we want to restore is the underlying extension, not
// ourselves.
let originalWindowNostr: Window['nostr'] | undefined;
let originalCaptured = false;

function captureOriginal() {
  if (typeof window === 'undefined') return;
  if (!originalCaptured) {
    originalWindowNostr = window.nostr;
    originalCaptured = true;
  }
}

export function activateAmberSigner(pubkey?: string): AmberSigner {
  if (typeof window === 'undefined') {
    throw new Error('Amber signer requires a browser environment');
  }
  captureOriginal();
  // Drop any other polyfill first — only one signer at a time.
  bunkerInstance = null;
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

/**
 * Install the BunkerAdapter as window.nostr. The adapter's `nostrApi`
 * already matches the expected shape, so we install it directly.
 */
export function activateBunkerSigner(adapter: BunkerAdapter) {
  if (typeof window === 'undefined') {
    throw new Error('Bunker signer requires a browser environment');
  }
  captureOriginal();
  amberInstance = null;
  bunkerInstance = adapter;
  window.nostr = adapter.nostrApi;
}

export function deactivateBunkerSigner() {
  if (typeof window === 'undefined') return;
  // Best-effort close of the underlying NIP-46 transport. Ignored if it
  // throws — the user is signing out, the connection's already past its
  // useful life.
  if (bunkerInstance) {
    try { bunkerInstance.inner.close(); } catch { /* ignore */ }
  }
  bunkerInstance = null;
  if (originalCaptured) {
    window.nostr = originalWindowNostr;
  }
}

export function isBunkerActive(): boolean {
  return bunkerInstance !== null;
}

export function getActiveBunker(): BunkerAdapter | null {
  return bunkerInstance;
}

// NIP-04 / NIP-44 capability accessors — see signer-shape comment at top
// of file. Both AmberSigner and the BunkerAdapter expose nip04 / nip44
// directly, so the optional chain works the same as for a NIP-07
// extension.

type Nip04Api = NonNullable<NonNullable<Window['nostr']>['nip04']>;
type Nip44Api = NonNullable<NonNullable<Window['nostr']>['nip44']>;

export function getNip04(): Nip04Api | null {
  if (typeof window === 'undefined') return null;
  return window.nostr?.nip04 ?? null;
}

export function getNip44(): Nip44Api | null {
  if (typeof window === 'undefined') return null;
  return window.nostr?.nip44 ?? null;
}

export function requireNip44(): Nip44Api {
  const n44 = getNip44();
  if (!n44) {
    throw new Error(
      'Nostr signer does not expose NIP-44. Use Alby or nos2x with NIP-44 support.',
    );
  }
  return n44;
}

