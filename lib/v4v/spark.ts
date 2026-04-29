'use client';

// Spark rail — Breez Spark SDK adapter. Self-custodial wallet whose mnemonic
// is bootstrapped from a NIP-44-encrypted backup on Nostr relays
// (lib/nostr/wallet-backup.ts).
//
// Send capabilities: BOLT11 invoices and Spark addresses. Keysend is NOT
// supported by this rail — node-pubkey value-block legs degrade in
// lib/v4v/boost.ts. lnaddress legs work because payOne fetches a BOLT11 from
// the LNURL-pay endpoint first.
//
// Init is two-stage because the SDK ships as a WebAssembly module. The
// default export of '@breeztech/breez-sdk-spark' is the WASM loader; it
// must run once before any other SDK call. We dynamic-import inside
// sparkInitFromMnemonic so the ~1MB WASM payload only lands in the bundle
// the first time a user actually opens a Spark wallet.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

// SDK instance + module references are loosely typed because the SDK's
// generated wasm bindings change frequently across minor versions; we
// pin the public surface (hasSpark / sparkPayInvoice / sparkDisconnect)
// and let TypeScript validate at the call boundary.
type SparkSdk = {
  sendPayment: (req: any) => Promise<any>;
  prepareSendPayment: (req: any) => Promise<any>;
  receivePayment: (req: any) => Promise<any>;
  disconnect: () => Promise<void>;
  getInfo: (req: any) => Promise<any>;
  addEventListener: (listener: { onEvent: (e: SparkSdkEvent) => void }) => Promise<string>;
  removeEventListener: (id: string) => Promise<boolean>;
};

// Mirror of @breeztech/breez-sdk-spark's SdkEvent discriminated union.
// Re-declared here so callers can subscribe without dragging the SDK
// types into client components.
export type SparkSdkEvent =
  | { type: 'synced' }
  | { type: 'unclaimedDeposits'; unclaimedDeposits: unknown[] }
  | { type: 'claimedDeposits'; claimedDeposits: unknown[] }
  | { type: 'newDeposits'; newDeposits: unknown[] }
  | { type: 'paymentSucceeded'; payment: unknown }
  | { type: 'paymentPending'; payment: unknown }
  | { type: 'paymentFailed'; payment: unknown }
  | { type: 'optimization'; optimizationEvent: unknown }
  | { type: 'lightningAddressChanged'; lightningAddress?: unknown };

let sdk: SparkSdk | null = null;
let activePubkey: string | null = null;
let wasmInitialized = false;

// Components reading hasSpark() during render need to refresh when the
// module-level state flips outside their own tree (e.g. the auto-restore in
// nostr-auth.tsx fires while the account menu is already open). Listeners
// are notified on every init/disconnect so the UI re-reads.
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
}

/** Subscribe to wallet state changes. Returns an unsubscribe fn. */
export function subscribeSpark(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** True once a wallet has been initialized for the current session. */
export function hasSpark(): boolean {
  return sdk !== null;
}

/** Pubkey the loaded wallet was bootstrapped for, for sanity-checking on identity changes. */
export function sparkOwner(): string | null {
  return activePubkey;
}

// storageDir suffix derived from the mnemonic so two wallets for the same
// pubkey (rare but possible: disconnect → create-new with new seed) get
// different SDK storage directories. Keying on ownerPubkey alone would
// collide and either fail the second init or corrupt the first wallet.
function walletStorageDir(ownerPubkey: string, mnemonic: string): string {
  const walletId = bytesToHex(sha256(utf8ToBytes(mnemonic))).slice(0, 8);
  return `bmb-spark-${ownerPubkey.slice(0, 8)}-${walletId}`;
}

/**
 * Initialize the Spark SDK from a BIP-39 mnemonic. Call this once after
 * wallet-backup.ts hands you the decrypted seed, or after a fresh mnemonic
 * is generated for first-time users.
 */
export async function sparkInitFromMnemonic(args: {
  mnemonic: string;
  ownerPubkey: string;
  // Spark SDK supports `mainnet` and `regtest` only — there's no public
  // testnet for Spark. Use `regtest` against a local node for development;
  // first-boost smoke testing on mainnet with a few sats is the realistic
  // path.
  network?: 'mainnet' | 'regtest';
}): Promise<void> {
  const apiKey = process.env.NEXT_PUBLIC_BREEZ_API_KEY;
  if (!apiKey) {
    throw new Error(
      'NEXT_PUBLIC_BREEZ_API_KEY is not set. Add it to .env.local and restart the dev server.',
    );
  }

  // Dynamic import keeps the WASM out of the initial bundle.
  const mod = await import('@breeztech/breez-sdk-spark');
  if (!wasmInitialized) {
    // Default export loads + instantiates the WebAssembly binary. Idempotent
    // per-load but cheap to guard.
    await (mod.default as () => Promise<void>)();
    wasmInitialized = true;
  }

  const config = mod.defaultConfig(args.network ?? 'mainnet');
  config.apiKey = apiKey;

  const instance = await mod.connect({
    config,
    seed: { type: 'mnemonic', mnemonic: args.mnemonic },
    storageDir: walletStorageDir(args.ownerPubkey, args.mnemonic),
  });

  sdk = instance as unknown as SparkSdk;
  activePubkey = args.ownerPubkey;
  notify();
}

/** Pay a BOLT11 invoice via the Spark SDK. Returns the payment preimage. */
export async function sparkPayInvoice(invoice: string): Promise<string> {
  if (!sdk) throw new Error('Spark wallet not initialized');
  // Two-step prepare-then-send is required by the Spark SDK so the caller
  // could surface fees ahead of the user committing. We don't expose the
  // estimate today but pass through the prepareResponse as the SDK requires.
  const prepared = await sdk.prepareSendPayment({ paymentRequest: invoice });
  const res = await sdk.sendPayment({ prepareResponse: prepared });
  const preimage = res?.payment?.preimage ?? res?.payment?.details?.htlcDetails?.preimage;
  if (!preimage) throw new Error('Spark sendPayment returned no preimage');
  return preimage as string;
}

/**
 * Generate a fresh BIP-39 mnemonic. Uses @scure/bip39 directly — the SDK
 * also ships a helper but @scure is already on disk via nostr-tools and
 * produces format-compatible output, so we don't pay the WASM init cost
 * just to mint a phrase.
 */
export async function sparkGenerateMnemonic(): Promise<string> {
  const { generateMnemonic } = await import('@scure/bip39');
  const { wordlist } = await import('@scure/bip39/wordlists/english.js');
  return generateMnemonic(wordlist);
}

/** Tear down the SDK on sign-out. */
export async function sparkDisconnect(): Promise<void> {
  if (sdk) {
    try { await sdk.disconnect(); } catch { /* best effort */ }
  }
  sdk = null;
  activePubkey = null;
  notify();
}

/** Fetch the wallet's current balance + identity pubkey. */
export async function sparkGetInfo(): Promise<{ balanceSats: number; identityPubkey?: string } | null> {
  if (!sdk) return null;
  try {
    const info = await sdk.getInfo({});
    return {
      balanceSats: Number(info?.balanceSats ?? 0),
      identityPubkey: info?.identityPubkey,
    };
  } catch {
    return null;
  }
}

/**
 * Subscribe to SDK events (`paymentSucceeded`, `claimedDeposits`, `synced`,
 * etc.). Returns an unsubscribe fn. Use this instead of polling getInfo —
 * the balance reflects the new state synchronously inside the event,
 * because the SDK has already finished its claim/settle bookkeeping.
 */
export async function subscribeSparkEvents(
  onEvent: (e: SparkSdkEvent) => void,
): Promise<() => void> {
  if (!sdk) return () => {};
  const id = await sdk.addEventListener({ onEvent });
  return () => {
    if (sdk) sdk.removeEventListener(id).catch(() => {});
  };
}

/**
 * Generate a BOLT11 invoice the user can pay from any other Lightning wallet
 * to fund this Spark wallet. Returns the invoice string and the fee Spark
 * will charge to settle the incoming payment (in sats).
 */
export async function sparkReceiveInvoice(args: {
  amountSats?: number;
  description?: string;
}): Promise<{ invoice: string; feeSats: number }> {
  if (!sdk) throw new Error('Spark wallet not initialized');
  const res = await (sdk as any).receivePayment({
    paymentMethod: {
      type: 'bolt11Invoice',
      description: args.description ?? 'BoostMeBitch Spark deposit',
      amountSats: args.amountSats,
    },
  });
  return {
    invoice: String(res?.paymentRequest ?? ''),
    feeSats: Number(res?.fee ?? 0),
  };
}
