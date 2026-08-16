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
//   activateLocalSigner(skHex)     — install LocalSigner as window.nostr
//   deactivateLocalSigner()        — restore the original window.nostr
//   isLocalActive()                — true while LocalSigner is active

import { AmberSigner } from './amber';
import { LocalSigner } from './local-signer';
import type { BunkerAdapter } from './bunker';

let amberInstance: AmberSigner | null = null;
let bunkerInstance: BunkerAdapter | null = null;
let localInstance: LocalSigner | null = null;
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
  localInstance = null;
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
  localInstance = null;
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

/**
 * Install a LocalSigner (a key this app holds) as window.nostr. Unlike the
 * other two this signs in-process, so the key's storage is handled separately
 * — see lib/nostr/local-key-store.ts.
 */
export function activateLocalSigner(skHex: string): LocalSigner {
  if (typeof window === 'undefined') {
    throw new Error('Local signer requires a browser environment');
  }
  captureOriginal();
  amberInstance = null;
  bunkerInstance = null;
  localInstance = new LocalSigner(skHex);
  // Publish the plain API object, NOT the instance — `private sk` is erased at
  // runtime, so assigning the instance would put the raw secret key on
  // window.nostr.sk for any script on this origin. Mirrors the bunker's
  // adapter.nostrApi above. See the comment on LocalSigner.nostrApi.
  window.nostr = localInstance.nostrApi as unknown as Window['nostr'];
  return localInstance;
}

export function deactivateLocalSigner() {
  if (typeof window === 'undefined') return;
  localInstance = null;
  if (originalCaptured) {
    window.nostr = originalWindowNostr;
  }
}

export function isLocalActive(): boolean {
  return localInstance !== null;
}

// Deliberately NO getActiveLocal() accessor, unlike getActiveAmber /
// getActiveBunker. Those hand out adapters that talk to a signer living
// elsewhere; a LocalSigner holds the raw key in-process. `private sk` is erased
// at runtime, so a general-purpose accessor for the instance is a standing
// offer of the secret key to anything that imports it — three lines below the
// comment explaining why activateLocalSigner publishes `nostrApi` and not the
// instance. loginWithLocalKey uses activateLocalSigner's own return value,
// which is scoped to that one call. Don't add one back, and don't add a
// key-export method either (one existed, had zero call sites, and was deleted).

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

// NIP-44 decrypt calls go through the user's signer (extension, Amber,
// bunker). On iOS, the extension background service worker can be killed
// between the relay query and the decrypt call, leaving the promise pending
// forever. Cap every background decrypt so it rejects instead of hanging.
//
// This lives here rather than in a caller because it was duplicated verbatim —
// same body, same 10 s constant — in lib/nostr/wallet-backup.ts and
// lib/nostr/settings-backup.ts, which are the two background restore paths and
// so exactly the places a hang is invisible. Both already import from this
// module, so sharing it adds no import edge. Any new encrypted-to-self backup
// should use this rather than awaiting requireNip44().decrypt directly.
const NIP44_DECRYPT_TIMEOUT_MS = 10_000;

export function decryptWithTimeout(pubkey: string, ciphertext: string): Promise<string> {
  return Promise.race([
    requireNip44().decrypt(pubkey, ciphertext),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('nip44 decrypt timed out')), NIP44_DECRYPT_TIMEOUT_MS),
    ),
  ]);
}

