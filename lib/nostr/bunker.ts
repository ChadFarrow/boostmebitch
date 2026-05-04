'use client';

// NIP-46 remote signer ("bunker") wrapper.
//
// Two flows:
//   1. PASTE flow ("Have URI"): user copies a bunker:// URI from their
//      remote signer (nsec.app, Amber-as-bunker, etc.) and pastes it here.
//      We parse it via parseBunkerInput, generate a client secret, and
//      connect.
//   2. GENERATE flow ("Generate URI"): we create a nostrconnect:// URI
//      with our client pubkey + a relay set, the user pastes it into
//      their signer, and the signer connects back to us.
//
// In both cases the result is a `BunkerSigner` from nostr-tools/nip46
// that exposes camelCase methods (signEvent, nip04Encrypt, etc.). We wrap
// it in a `BunkerSignerAdapter` whose shape matches `Window['nostr']` so
// the rest of the app — which already reads `window.nostr.signEvent` /
// `window.nostr.nip04.encrypt` — doesn't care which backend is active.
//
// Persisted state (lib/storage.ts:storage.bunker):
//   - uri:       the original bunker:// or nostrconnect:// URI
//   - clientSk:  hex-encoded client secret key. Persisting this is what
//                lets a refresh keep the same logical client identity, so
//                the bunker doesn't re-auth on every page load.

import {
  BunkerSigner,
  createNostrConnectURI,
  parseBunkerInput,
  type BunkerPointer,
} from 'nostr-tools/nip46';
import {
  generateSecretKey,
  getPublicKey,
  type Event,
  type EventTemplate,
} from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { storage } from '../storage';

// Default relays for the GENERATE flow's nostrconnect:// URI. These need
// to be reachable by both this app and whatever remote signer the user
// uses. Damus.io / nsec.app are widely supported NIP-46 relays.
const NOSTRCONNECT_RELAYS = [
  'wss://relay.nsec.app',
  'wss://relay.damus.io',
];

const NOSTRCONNECT_TIMEOUT_MS = 120_000;

// How long any single bunker call (signEvent / nip04 / nip44) is allowed
// to wait before we conclude the relay subscription is dead. iOS PWA
// suspends backgrounded WebSockets, so a sign call after the user
// returns can hang indefinitely without this bound. 30s is well above
// the typical 1-3s round-trip but short enough that the user can
// recover via the "Reconnect" affordance instead of staring at a
// frozen UI.
const BUNKER_CALL_TIMEOUT_MS = 30_000;

// First-time `connect()` is the slow path — Primal/Clave/nsec.app may
// surface an auth_url that the user has to tap, switch apps, approve,
// then come back. nostr-tools' connect() has no timeout, so without
// this bound the UI is stuck on "Connecting…" forever if the user
// never approves, the relay drops, or iOS suspended Safari's WebSocket
// while the user was in the signer app. 90s gives a comfortable margin
// for the round-trip + manual approval.
const BUNKER_CONNECT_TIMEOUT_MS = 90_000;

// Module-level memo: the last clientSk we generated for a given pasted
// URI. The iOS Safari + Primal failure mode is that the user approves
// in Primal, but iOS suspended the WebSocket while they were in the
// other app, so the bunker's connect-ack is delivered to a dead
// subscription and lost. nostr-tools' setupSubscription uses limit:0
// with no `since`, so reconnecting can't replay the missed event.
//
// On retry within the same paste session we want to reuse the SAME
// clientSk so the bunker recognizes us as the already-approved client
// and acks immediately on the next connect request, rather than
// re-prompting the user to approve a brand-new client. Keyed on the
// sanitized URI so different pastes don't collide; cleared on
// successful connect or when the user signs out/clears the textarea.
const pendingClientSks = new Map<string, Uint8Array>();

// Module-level health flag + listener set. Set when any wrapped call
// times out or throws; cleared by restoreBunkerSigner on a successful
// reconnect. The account-menu reconnect banner subscribes via
// subscribeBunkerHealth.
let bunkerStale = false;
const healthListeners = new Set<(stale: boolean) => void>();

function setBunkerStale(stale: boolean) {
  if (bunkerStale === stale) return;
  bunkerStale = stale;
  for (const fn of healthListeners) {
    try { fn(stale); } catch { /* ignore */ }
  }
}

export function isBunkerStale(): boolean {
  return bunkerStale;
}

export function markBunkerStale(): void {
  setBunkerStale(true);
}

export function clearBunkerStale(): void {
  setBunkerStale(false);
}

export function subscribeBunkerHealth(fn: (stale: boolean) => void): () => void {
  healthListeners.add(fn);
  fn(bunkerStale);
  return () => { healthListeners.delete(fn); };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Bunker ${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// Wrap a bunker call with the timeout + stale-flag side effect. Failures
// (timeout or rejection) flip bunkerStale so UI can surface a reconnect
// affordance; successful calls reset the flag (covers the case where the
// transport actually recovered without a restoreBunkerSigner cycle).
async function trackBunkerCall<T>(p: Promise<T>, label: string): Promise<T> {
  try {
    const v = await withTimeout(p, BUNKER_CALL_TIMEOUT_MS, label);
    if (bunkerStale) setBunkerStale(false);
    return v;
  } catch (e) {
    setBunkerStale(true);
    throw e;
  }
}

export interface BunkerAdapter {
  /** Underlying nostr-tools BunkerSigner. Exposed for close() in disconnect. */
  inner: BunkerSigner;
  /** Stable across calls — fetched once via inner.getPublicKey(). */
  pubkey: string;
  /** The window.nostr-shaped surface we polyfill. */
  nostrApi: NonNullable<Window['nostr']>;
  /** Original URI we connected with — re-used on reload for restore. */
  uri: string;
  /** Client secret key as hex; persisted alongside uri for restore. */
  clientSkHex: string;
}

/** Wrap a connected BunkerSigner in the Window['nostr'] shape. Each call
 *  goes through trackBunkerCall so timeouts / errors flip the stale flag
 *  for the reconnect UI. */
function adaptToWindowNostr(signer: BunkerSigner): NonNullable<Window['nostr']> {
  return {
    getPublicKey: () => trackBunkerCall(signer.getPublicKey(), 'get_public_key'),
    signEvent: (template: EventTemplate): Promise<Event> =>
      trackBunkerCall(signer.signEvent(template), 'sign_event') as Promise<Event>,
    nip04: {
      encrypt: (peerPubkey, plaintext) =>
        trackBunkerCall(signer.nip04Encrypt(peerPubkey, plaintext), 'nip04_encrypt'),
      decrypt: (peerPubkey, ciphertext) =>
        trackBunkerCall(signer.nip04Decrypt(peerPubkey, ciphertext), 'nip04_decrypt'),
    },
    nip44: {
      encrypt: (peerPubkey, plaintext) =>
        trackBunkerCall(signer.nip44Encrypt(peerPubkey, plaintext), 'nip44_encrypt'),
      decrypt: (peerPubkey, ciphertext) =>
        trackBunkerCall(signer.nip44Decrypt(peerPubkey, ciphertext), 'nip44_decrypt'),
    },
  };
}

/**
 * Normalize a pasted bunker URI so we tolerate the cruft mobile clipboards
 * (and copy buttons in signers like Primal) tend to introduce:
 *   - leading/trailing whitespace, newlines from copy-paste UI
 *   - zero-width / BOM / NBSP characters that some "share sheet" flows
 *     prepend on iOS
 *   - uppercase hex in the bunker pubkey (NIP-46's reference regex is
 *     strict-lowercase; signers don't always agree)
 * Anything else is left intact so URL-encoded relay/secret values pass
 * through untouched.
 */
function sanitizeBunkerUri(input: string): string {
  // Strip whitespace + common invisible code points anywhere in the string.
  // \s covers ASCII + unicode whitespace; the explicit characters cover
  // ZWSP (200B), ZWNJ (200C), ZWJ (200D), BOM (FEFF), NBSP (00A0).
  let cleaned = input.replace(/[\s​-‍﻿ ]/g, '');
  const m = cleaned.match(/^bunker:\/\/([0-9a-fA-F]{64})(.*)$/);
  if (m) {
    cleaned = `bunker://${m[1].toLowerCase()}${m[2]}`;
  }
  return cleaned;
}

/**
 * PASTE flow. Parses a bunker:// URI (or NIP-05 like name@example.com),
 * generates a fresh client secret, connects, and returns the adapter.
 *
 * `onAuthUrl` fires if the bunker requires the user to open an approval
 * URL during connect (Primal, nsec.app, Clave first-time flows).
 */
export async function connectBunkerFromUri(
  uri: string,
  onAuthUrl?: (url: string) => void,
): Promise<BunkerAdapter> {
  const cleaned = sanitizeBunkerUri(uri);
  if (!cleaned) {
    throw new Error('Empty bunker URI. Paste a `bunker://…` URI from your remote signer.');
  }
  const pointer = await parseBunkerInput(cleaned);
  if (!pointer) {
    throw new Error(
      'Could not parse bunker URI. Expected `bunker://<64-hex-pubkey>?relay=…` or a NIP-05 like `name@domain`. ' +
        'On Primal: Settings → Keys → Remote Signer → copy the connection string.',
    );
  }
  // Reuse a previous attempt's clientSk on retry so an already-approved
  // bunker doesn't re-prompt. See pendingClientSks comment above.
  let clientSk = pendingClientSks.get(cleaned);
  if (!clientSk) {
    clientSk = generateSecretKey();
    pendingClientSks.set(cleaned, clientSk);
  }
  const signer = BunkerSigner.fromBunker(clientSk, pointer, {
    onauth: onAuthUrl,
  });
  // nostr-tools' connect() has no built-in timeout. Without this bound
  // a stalled relay or a never-approved auth_url leaves the UI on
  // "Connecting…" forever. Same for getPublicKey on the just-connected
  // signer — it's another round-trip over the same transport. On
  // failure, leave the clientSk in pendingClientSks so the user's next
  // tap of Connect reuses the already-approved client identity.
  await withTimeout(
    signer.connect(),
    BUNKER_CONNECT_TIMEOUT_MS,
    'connect (approve in your signer, then tap Connect again — iOS may have suspended the relay link)',
  );
  const pubkey = await withTimeout(
    signer.getPublicKey(),
    BUNKER_CALL_TIMEOUT_MS,
    'get_public_key',
  );
  pendingClientSks.delete(cleaned);
  return {
    inner: signer,
    pubkey,
    nostrApi: adaptToWindowNostr(signer),
    uri: cleaned,
    clientSkHex: bytesToHex(clientSk),
  };
}

/** Drop any in-flight clientSk memo. Called when the user clears the
 *  textarea or successfully completes a different login flow, so a
 *  stale clientSk doesn't outlive the paste session. */
export function clearPendingBunkerAttempts(): void {
  pendingClientSks.clear();
}

/**
 * GENERATE flow. Creates a nostrconnect:// URI for the user to paste into
 * their remote signer; the returned promise resolves once the signer
 * connects back. No `perms` field — bunker prompts per call.
 */
export function startNostrConnect(
  onAuthUrl?: (url: string) => void,
): { uri: string; ready: Promise<BunkerAdapter> } {
  const clientSk = generateSecretKey();
  const clientPubkey = getPublicKey(clientSk);
  // Random secret echoes back from the bunker's "connect" reply so we know
  // the connection paired correctly (NIP-46 requires this).
  const secret = bytesToHex(generateSecretKey()).slice(0, 16);
  const uri = createNostrConnectURI({
    clientPubkey,
    relays: NOSTRCONNECT_RELAYS,
    secret,
    name: 'Boost Me Bitch',
  });
  const ready = (async () => {
    const signer = await BunkerSigner.fromURI(
      clientSk,
      uri,
      { onauth: onAuthUrl },
      NOSTRCONNECT_TIMEOUT_MS,
    );
    const pubkey = await withTimeout(
      signer.getPublicKey(),
      BUNKER_CALL_TIMEOUT_MS,
      'get_public_key',
    );
    return {
      inner: signer,
      pubkey,
      nostrApi: adaptToWindowNostr(signer),
      uri,
      clientSkHex: bytesToHex(clientSk),
    };
  })();
  return { uri, ready };
}

/**
 * On page reload, rebuild the BunkerSigner from the persisted URI +
 * client secret. The signer's transport (NIP-04 DMs over a relay) is
 * stateless on the wire, so passing the same clientSk lets us resume
 * without a new auth round-trip.
 *
 * Returns null if there's nothing to restore. Throws if the persisted
 * URI was nostrconnect:// (we don't have the bunker pubkey to reconnect
 * to in that case — the bunker has to initiate). In practice users
 * paste a bunker:// or get one from the GENERATE flow's resolved
 * BunkerPointer; we persist the bunker:// form below.
 */
export async function restoreBunkerFromStorage(): Promise<BunkerAdapter | null> {
  const cached = storage.bunker.get();
  if (!cached) return null;
  let pointer: BunkerPointer | null = null;
  try {
    pointer = await parseBunkerInput(cached.uri);
  } catch {
    pointer = null;
  }
  if (!pointer) {
    // Likely a nostrconnect:// URI we couldn't restore; clear so the user
    // can reconnect manually.
    storage.bunker.clear();
    return null;
  }
  const clientSk = hexToBytes(cached.clientSk);
  const signer = BunkerSigner.fromBunker(clientSk, pointer);
  await withTimeout(signer.connect(), BUNKER_CONNECT_TIMEOUT_MS, 'reconnect');
  const pubkey = await withTimeout(
    signer.getPublicKey(),
    BUNKER_CALL_TIMEOUT_MS,
    'get_public_key',
  );
  return {
    inner: signer,
    pubkey,
    nostrApi: adaptToWindowNostr(signer),
    uri: cached.uri,
    clientSkHex: cached.clientSk,
  };
}

/**
 * Convert the GENERATE flow's adapter (whose `uri` is nostrconnect://)
 * into a persistable bunker:// pointer once the signer has actually
 * connected. After connect we know the bunker's pubkey + relays from the
 * underlying signer, so we can build a bunker:// URI for restore.
 */
export function bunkerUriForRestore(adapter: BunkerAdapter): string {
  // If it's already bunker://, keep it.
  if (adapter.uri.startsWith('bunker://')) return adapter.uri;
  // Otherwise build one from the underlying signer's BunkerPointer.
  const bp = adapter.inner.bp;
  const params = new URLSearchParams();
  for (const r of bp.relays) params.append('relay', r);
  if (bp.secret) params.set('secret', bp.secret);
  return `bunker://${bp.pubkey}?${params.toString()}`;
}
