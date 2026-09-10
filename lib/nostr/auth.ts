// NIP-07 sign-in. The window globals declared here cover both the Nostr
// signer and the WebLN provider (Lightning lib in @/lib/v4v/webln also uses
// it via this same module-level declaration).
//
// Amber (NIP-55, Android) is supported by polyfilling window.nostr with an
// AmberSigner instance — see lib/nostr/signer.ts and lib/nostr/amber.ts. The
// rest of the app reads window.nostr without caring which backend it is.

import { nip19, type Event, type EventTemplate } from 'nostr-tools';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  activateAmberSigner,
  activateBunkerSigner,
  activateLocalSigner,
  deactivateAmberSigner,
  deactivateBunkerSigner,
  revokeBunkerSession,
  deactivateLocalSigner,
  extensionNostr,
  getActiveBunker,
  closeStaleBunkerTransport,
} from './signer';
import { clearKey, getKey, putKey } from './local-key-store';
import {
  bunkerUriForRestore,
  clearBunkerStale,
  connectBunkerFromUri,
  isRemoteSignerError,
  markBunkerStale,
  pingBunkerAdapter,
  restoreBunkerFromStorage,
  startNostrConnect,
  type BunkerAdapter,
} from './bunker';
import { storage } from '../storage';
import type { ProfileMetadata } from './profile-metadata';

declare global {
  interface Window {
    nostr?: {
      getPublicKey: () => Promise<string>;
      signEvent: (e: EventTemplate) => Promise<Event>;
      nip04?: {
        encrypt: (pubkey: string, plaintext: string) => Promise<string>;
        decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
      };
      // NIP-44 v2. Used to encrypt-to-self the Spark wallet mnemonic for the
      // Nostr-hosted backup in lib/nostr/wallet-backup.ts.
      nip44?: {
        encrypt: (pubkey: string, plaintext: string) => Promise<string>;
        decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
      };
    };
    webln?: {
      enable: () => Promise<void>;
      sendPayment: (invoice: string) => Promise<{ preimage: string }>;
      keysend?: (args: {
        destination: string;
        amount: number;
        customRecords?: Record<string, string>;
      }) => Promise<{ preimage: string }>;
      lnurl?: (lnurl: string) => Promise<any>;
    };
  }
}

export interface NostrIdentity {
  pubkey: string;        // hex
  npub: string;          // bech32
  profile?: ProfileMetadata;
  writeRelays?: string[]; // from NIP-65 kind:10002 (write or unmarked entries)
}

export async function loginWithExtension(): Promise<NostrIdentity> {
  const ext = extensionNostr();
  if (!ext) {
    throw new Error(
      'No Nostr signer found. Install Alby, nos2x, or another NIP-07 extension.',
    );
  }
  const pubkey = await ext.getPublicKey();
  return { pubkey, npub: nip19.npubEncode(pubkey) };
}

/**
 * Sign in via the Amber Android signer (NIP-55). Installs an AmberSigner as
 * window.nostr so subsequent signEvent / nip04 / nip44 calls route through
 * the same `nostrsigner:` deep-link flow; the original window.nostr (a
 * NIP-07 extension, if any) is restored on sign-out.
 *
 * The first call opens an Amber popup tab to fetch the pubkey. Subsequent
 * page loads can call `restoreAmberSigner` instead — synchronous, no popup.
 */
export async function loginWithAmber(): Promise<NostrIdentity> {
  const signer = activateAmberSigner();
  try {
    const pubkey = await signer.getPublicKey();
    return { pubkey, npub: nip19.npubEncode(pubkey) };
  } catch (e) {
    // Roll back the polyfill if Amber rejected/timed out — otherwise we'd
    // leave window.nostr pointing at an Amber instance the user never agreed
    // to, and the next signEvent would silently re-prompt them through Amber.
    deactivateAmberSigner();
    throw e;
  }
}

/**
 * Reinstall the AmberSigner polyfill on page load when the user previously
 * signed in with Amber. Synchronous — does NOT call Amber. The cached pubkey
 * lets the signer answer getPublicKey() without a popup, mirroring how
 * NIP-07 extensions hold the pubkey in memory.
 */
export function restoreAmberSigner(pubkey: string) {
  activateAmberSigner(pubkey);
}

/** Drop the Amber polyfill, restoring the underlying window.nostr (if any). */
export function clearAmberSigner() {
  deactivateAmberSigner();
}

/**
 * Sign in via a NIP-46 bunker URI (paste flow). The user has copied a
 * `bunker://…` URI (or a NIP-05 like `name@example.com`) from their
 * remote signer; we generate a fresh client secret, connect, and install
 * the adapter as window.nostr.
 *
 * `onAuthUrl` fires when the bunker requires the user to open a URL to
 * approve the connection (e.g. nsec.app's first-time flow). Surface that
 * URL in the UI so the user can complete it.
 */
export async function loginWithBunker(
  input: string,
  onAuthUrl?: (url: string) => void,
): Promise<NostrIdentity> {
  const adapter = await connectBunkerFromUri(input, onAuthUrl);
  return finalizeBunkerLogin(adapter);
}

/**
 * Sign in via a NIP-46 nostrconnect:// URI (generate flow). Returns the
 * URI immediately for the caller to display, plus a `ready` promise that
 * resolves to a `NostrIdentity` once the signer connects back. Caller is
 * responsible for showing the URI to the user (paste / QR / copy) until
 * the promise settles.
 *
 * `abandon` is passed straight through from `startNostrConnect` rather than
 * wrapped: a caller that opens a second listener on this pairing has to be able
 * to close the first, and this is the only layer between it and the UI.
 */
export function loginWithNostrConnect(
  onAuthUrl?: (url: string) => void,
): { uri: string; ready: Promise<NostrIdentity>; abandon: () => void } {
  const { uri, ready: adapterReady, abandon } = startNostrConnect(onAuthUrl);
  const ready = adapterReady.then((adapter) => finalizeBunkerLogin(adapter));
  // Same reason as `startNostrConnect`'s own: `.then` makes a NEW promise, and
  // an abandoned attempt rejecting it with nobody attached is an unhandled
  // rejection for a routine event.
  ready.catch(() => { /* the caller's own handler reports what matters */ });
  return { uri, ready, abandon };
}

function finalizeBunkerLogin(adapter: BunkerAdapter): NostrIdentity {
  // The adapter's `uri` is whatever we connected with (bunker:// or
  // nostrconnect://). For restore-on-reload we need a bunker:// pointer,
  // so build one from the underlying signer's BunkerPointer if needed.
  const persistUri = bunkerUriForRestore(adapter);
  storage.bunker.set({ uri: persistUri, clientSk: adapter.clientSkHex });
  activateBunkerSigner(adapter);
  return {
    pubkey: adapter.pubkey,
    npub: nip19.npubEncode(adapter.pubkey),
  };
}

/**
 * The three outcomes of a bunker restore, and **they are three because the
 * caller has to act differently on each.** This used to be a `boolean`, and
 * collapsing the last two is what made a dropped network connection sign the
 * user out of Nostr *and* disconnect their wallet.
 *
 * `no-session` is a fact about storage: nothing was persisted, or the pointer
 * does not parse. `unreachable` is a fact about the transport: the pointer is
 * intact and the signer did not answer within `BUNKER_CONNECT_TIMEOUT_MS`.
 * A phone that suspends a WebSocket produces the second one every time, and
 * `abandonRestoredSession` — the only thing the old `false` could lead to —
 * clears `bmb:npub`, `bmb:signer`, the NWC URI *and* `storage.bunker`. Losing
 * the pointer is the part that has no way back: the account menu's Reconnect
 * button calls this function, and it needs the pointer that was just deleted,
 * so the user has to pair Clave from scratch. `clearBunkerSigner` is called
 * without `revoke` there, so the signer keeps its half of the dead pairing —
 * and Clave caps a user at five. Every network drop burned a slot.
 *
 * The two cannot be told apart downstream, which is why the discrimination is
 * here: `restoreBunkerFromStorage` returns `null` for the storage fact and
 * THROWS for the transport one. That is safe to lean on because a stored
 * pointer is always `bunker://` (`bunkerUriForRestore`), and nostr-tools'
 * `parseBunkerInput` parses that form with a regex and no network — so an
 * offline device cannot manufacture a `no-session`.
 *
 * Marking the transport case stale here rather than at the call site keeps the
 * two reconnect paths (page load, and the account menu's button) in step, and
 * satisfies CLAUDE.md's rule that a guard which withholds must say so: the flag
 * is what renders `<BunkerHealthBanner>`.
 *
 * Async — it has to reconnect the NIP-46 transport. The fast-path useEffect
 * kicks it off in the background; signing operations that arrive before it
 * resolves will throw, but nothing signs unprompted right after page load.
 */
export type BunkerRestoreResult =
  | { kind: 'ok' }
  | { kind: 'no-session' }
  | { kind: 'unreachable' }
  /** The signer ANSWERED and the answer was no. `message` is its own words. */
  | { kind: 'refused'; message: string };

/**
 * A REFUSAL IS NOT AN ABSENCE, and this function used to report one as the
 * other.
 *
 * `restoreBunkerFromStorage` throws for two completely different facts and this
 * caught both with a bare `catch`. One is a dead transport. The other is the
 * signer answering, over a link that demonstrably works, that it will not take
 * this client — and Clave has three of those on `connect` alone
 * (`Shared/LightSigner.swift`): *"Invalid or missing bunker secret"* and
 * *"Client not paired — send connect with valid bunker secret first"* when the
 * pairing is gone from its side, and *"Pairing limit reached"* at its cap of
 * five. None of them is approval-pending, so each propagates on the first
 * answer.
 *
 * Reported from an iPhone: RECONNECT rendered *"No answer from your signer.
 * Open it, then try again."* — both halves false, and the retry it asks for
 * cannot work, because the fix is to PAIR AGAIN (or free a slot in Clave), not
 * to open the app. `markBunkerStale()` compounded it by pointing the reconnect
 * banner at a link that was never down.
 *
 * This is CLAUDE.md's *"a bunker that answers with an error is not a bunker
 * that is gone"* reached one level up: `trackBunkerCall` already gets this
 * right and CLEARS the flag on a signer's answer, and this function then set it
 * again on the way out. `isRemoteSignerError` is the same discriminator, with
 * the same coupling to the exact `nostr-tools` 2.19.4 pin — the library rejects
 * with the signer's error STRING, unwrapped, and every other rejection on that
 * path is an `Error`.
 *
 * THE PROBE IS THE OTHER HALF, and it runs before anything is built. See
 * `pingBunkerAdapter`: a pong proves the link this session already holds is
 * alive, which the `bunkerStale` flag cannot — that flag is set by any local
 * throw, a timeout on a request the signer is holding open for the user
 * included. Without it the reconnect rebuilds a working transport, and on iOS
 * the rebuild competes with the sockets the old one still holds.
 */
export async function restoreBunkerSigner(): Promise<BunkerRestoreResult> {
  // The transport this session already has, if any. Null on a page-load
  // restore, which is the path with nothing to probe and nothing to close.
  const live = getActiveBunker();
  if (live && await pingBunkerAdapter(live)) {
    clearBunkerStale();
    return { kind: 'ok' };
  }
  // Proven dead: hand its sockets back BEFORE opening their replacement.
  if (live) closeStaleBunkerTransport();

  let adapter: BunkerAdapter | null;
  try {
    adapter = await restoreBunkerFromStorage();
  } catch (e) {
    // The signer answered. The link works, the pairing does not — say so in the
    // signer's own words. It still marks the session stale, because that flag
    // is the only thing keeping <BunkerHealthBanner> and its dot on screen and
    // a refusal is exactly as unusable as a dead link; `markBunkerStale` says
    // why at more length.
    //
    // A NON-EMPTY STRING, not merely "not an Error". `isRemoteSignerError` is
    // the repo's discriminator for "this came off the wire" and it is right —
    // but the branch below shows the value to a human, and a signer that put an
    // object in `error` would render as "[object Object]". Same guard
    // `isApprovalPending` applies for the same reason. Anything else falls
    // through to `unreachable`, which asks for a retry that costs nothing.
    if (isRemoteSignerError(e) && typeof e === 'string' && e.trim()) {
      const message = e.trim();
      markBunkerStale(message);
      return { kind: 'refused', message };
    }
    // The relay did not answer. The user asked for nothing and decided
    // nothing, so nothing they own is torn down — see `clearBunkerSigner`,
    // which already states this rule for the pairing and was not being
    // followed here.
    markBunkerStale();
    return { kind: 'unreachable' };
  }
  if (!adapter) return { kind: 'no-session' };
  activateBunkerSigner(adapter);
  clearBunkerStale();
  return { kind: 'ok' };
}

/**
 * Drop the bunker polyfill + persisted session, restoring the underlying
 * window.nostr (if any).
 *
 * `revoke` also tells the SIGNER to forget this client, and the two callers want
 * opposite things. A deliberate sign-out should remove the connection at both
 * ends — a NIP-46 pairing is state on the signer's side that closing our socket
 * does not touch, and **Clave caps a user at five connections**, so dead entries
 * from old sessions are a real cost the user can only clear by hand in another
 * app. A FAILED RESTORE is the opposite case: the socket was suspended or a
 * relay did not answer, the user asked for nothing, and burning a working
 * pairing over a transient fault would make them pair again from scratch. So it
 * is opt-in, and `abandonRestoredSession` does not opt in.
 *
 * Still synchronous. `revokeBunkerSession` detaches the adapter immediately and
 * lets the round trip finish on its own — see its header.
 */
export function clearBunkerSigner({ revoke = false }: { revoke?: boolean } = {}) {
  if (revoke) revokeBunkerSession();
  else deactivateBunkerSigner();
  storage.bunker.clear();
}

/**
 * Sign in with a key this app holds itself (the Google-onboarding path — see
 * components/nostr-auth/google-auth-panel.tsx). Installs the LocalSigner
 * polyfill and persists the key behind a non-extractable CryptoKey.
 *
 * The multi-step Google UX (PIN entry, account picker) deliberately stays in
 * the component; this is the thin part, mirroring finalizeBunkerLogin.
 */
export async function loginWithLocalKey(skHex: string): Promise<NostrIdentity> {
  const signer = activateLocalSigner(skHex);
  try {
    await putKey(skHex);
    const pubkey = await signer.getPublicKey();
    return { pubkey, npub: nip19.npubEncode(pubkey) };
  } catch (e) {
    // Roll the polyfill back rather than leaving window.nostr pointing at a
    // signer whose key we failed to persist.
    deactivateLocalSigner();
    throw e;
  }
}

/**
 * Reinstall the LocalSigner on page load. Async, unlike restoreAmberSigner —
 * the key has to come back out of IndexedDB and be decrypted. Modeled on the
 * bunker restore: signing calls that race ahead of it throw, but nothing signs
 * unprompted right after load.
 *
 * Returns false when no key is stored (or storage is unreadable), so the
 * caller can drop the signer-kind sentinel and show sign-in again.
 */
export async function restoreLocalSigner(): Promise<boolean> {
  try {
    const skHex = await getKey();
    if (!skHex) return false;
    // The stored key must match the identity the rest of the app is about to
    // paint from `bmb:npub`. These CAN disagree: putKey swallows IndexedDB
    // failures, so signing in as B on a device that already held A's key can
    // leave A's ciphertext on disk while the session runs off the in-memory
    // copy. After a reload the app would then sign every event as A while the
    // header, favorites, mutes and wallet all say B — and the resulting
    // nip44 failures are swallowed by their callers, so nothing surfaces it.
    // Refusing here sends the user back through sign-in instead.
    const stored = storage.npub.get();
    if (stored) {
      const pubkey = getPublicKey(hexToBytes(skHex));
      if (nip19.npubEncode(pubkey) !== stored) return false;
    }
    activateLocalSigner(skHex);
    return true;
  } catch {
    return false;
  }
}

/** Drop the local polyfill and wipe the stored key. */
export async function clearLocalSigner() {
  deactivateLocalSigner();
  await clearKey();
}



// `ProfileMetadata`, `coerceProfileMetadata` and `parseProfileContent` moved to
// ./profile-metadata, an import-free leaf, so `lib/storage.ts` can reach them
// without importing this file — that one edge was what made
// storage → auth → signer → amber → storage a real cycle. Re-exported here so
// every existing import site (and the `lib/nostr` barrel) is unchanged.
//
// `shortNpub` moved down for the same reason and by the same rule: it is a pure
// string elision that `lib/format.tsx` needs to render a mention, and 18
// modules import `lib/format.tsx` — reaching it through here would pull the
// signer stack into all of them.
export {
  coerceProfileMetadata,
  parseProfileContent,
  shortNpub,
  type ProfileMetadata,
} from './profile-metadata';
