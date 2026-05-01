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

// Capability accessors for NIP-04 / NIP-44 on whatever signer is currently
// installed at window.nostr. Returning the API object (or null) lets each
// caller pick its own policy without re-implementing the SSR / missing-
// extension / missing-feature check three different ways.
//
// Both AmberSigner and well-behaved NIP-07 extensions expose nip04 / nip44
// directly on window.nostr; the optional chain accommodates extensions that
// only ship a subset (e.g. nos2x without NIP-44).

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

/** Like getNip44 but throws a user-facing error when the signer doesn't
 *  expose NIP-44. Use this in flows where missing NIP-44 is a hard stop
 *  (e.g. the Spark wallet backup, which encrypts the mnemonic). */
export function requireNip44(): Nip44Api {
  const n44 = getNip44();
  if (!n44) {
    throw new Error(
      'Nostr signer does not expose NIP-44. Use Alby or nos2x with NIP-44 support.',
    );
  }
  return n44;
}
