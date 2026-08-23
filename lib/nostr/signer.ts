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

/**
 * Cap any signer decrypt so a signer that never answers rejects instead of
 * hanging.
 *
 * Exported because NIP-04 needs it too, and for the same measured reason: a
 * Safari extension's background is killed while a relay query is in flight, and
 * the decrypt issued after it comes back never settles. There is no rejection
 * to catch and no timeout of its own — the promise simply stays pending, which
 * silently wedges whatever awaited it. `hydrateMutes` is exactly that shape:
 * `fetchMutedPubkeys` awaits up to 4 s of relay time and then decrypts, and its
 * caller swallows failures with `.catch(() => {})`, so a hang there costs the
 * user their whole mute list with nothing on screen and nothing in the console.
 *
 * The bound is the same 10 s the NIP-44 path uses. A decrypt is local work in
 * every signer that answers at all; ten seconds is generous for the ones that
 * are merely slow and finite for the ones that are gone.
 */
export function withDecryptTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out`)), NIP44_DECRYPT_TIMEOUT_MS),
    ),
  ]);
}

/**
 * Why a decrypt is happening. REQUIRED, so a new caller has to decide rather
 * than inherit a permissive default.
 *
 *  - `'user-initiated'` — someone pressed something and is watching.
 *  - `'unattended'` — page-load hydration. Nobody asked for it and nobody is
 *    expecting a signer prompt.
 */
export type DecryptPurpose = 'user-initiated' | 'unattended';

/** Thrown instead of dispatching an unattended decrypt to an external signer. */
export class UnattendedDecryptRefused extends Error {
  constructor() {
    super('refusing to ask an external signer to decrypt without the user asking');
    this.name = 'UnattendedDecryptRefused';
  }
}

/**
 * NIP-44 decrypt with a timeout, and a refusal.
 *
 * **On Amber, an `'unattended'` decrypt is refused before it is dispatched, and
 * that is a privacy decision rather than a UX one.** Amber's approval sheet
 * renders the DECRYPTED PLAINTEXT so the user can see what they are approving.
 * That is reasonable of Amber. It is not reasonable of us to trigger it on
 * page load, because of what this app stores encrypted-to-self:
 *
 *   - `boostmebitch:wallet` is the Spark **seed phrase**. Observed on a Pixel 6:
 *     launching the app put twelve BIP-39 words full-screen and unmasked, before
 *     the user had touched anything.
 *   - `boostmebitch:wallet:nwc` is an NWC URI — a budgeted **spending
 *     credential**.
 *   - `boostmebitch:settings` is harmless in content, but still an uninvited
 *     trip to another app.
 *
 * A seed on screen at a moment the user did not choose is a shoulder, a
 * screenshot, or a screen recording away from being someone else's. The three
 * cold-start callers therefore do not ask at all on Amber (see
 * `doLoadProfile`); this refusal is the backstop that makes a FOURTH one, added
 * later by someone who never read this, fail loudly instead of quietly showing
 * a seed.
 *
 * **`'user-initiated'` is the escape hatch, and it has to reach here from the
 * CALL, never from the function.** `fetchEncryptedMnemonic` is used by both the
 * page-load restore and the wallet modal's "Restore from Nostr" button, so a
 * purpose hardcoded inside it is wrong for one of them — and the first version
 * of this guard hardcoded `'unattended'`, which refused the button too. The
 * user pressed it, was expecting the prompt, and got nothing. So every backup
 * reader takes `purpose` as a required argument and passes it straight down.
 *
 * Amber only, deliberately, and for the same reason
 * [`hydrateMutes`](./mutes-hydrator.ts) is: a NIP-07 extension and a bunker
 * answer inside the browser and the local signer is in-process, so none of them
 * render anything and refusing there would cost a fresh device its wallet for
 * nothing.
 */
export function decryptWithTimeout(
  pubkey: string,
  ciphertext: string,
  purpose: DecryptPurpose,
): Promise<string> {
  if (purpose === 'unattended' && isAmberActive()) {
    return Promise.reject(new UnattendedDecryptRefused());
  }
  return withDecryptTimeout(requireNip44().decrypt(pubkey, ciphertext), 'nip44 decrypt');
}

