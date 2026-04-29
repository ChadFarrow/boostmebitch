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
// SDK wiring is intentionally stubbed below: the package name and exact init
// signature for @breeztech/breez-sdk-spark may shift, and we don't want the
// dependency to break `next build` until we wire it for real. Drop the real
// import + connect call into the TODO blocks; the rest of the rail
// (hasSpark / sparkPayInvoice / sparkDisconnect) is the stable surface that
// boost.ts depends on.

// Replace `unknown` with the real SDK instance type when wiring.
type SparkSdk = unknown;

// Sentinel used by stub-mode init so hasSpark() flips true and the rail
// becomes selectable in the UI before the real SDK is wired. Replace this
// with the actual connect() return value when uncommenting the TODOs below.
const STUB_SDK: SparkSdk = { __stub: true };

let sdk: SparkSdk | null = null;
let activePubkey: string | null = null;

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

/**
 * Initialize the Spark SDK from a BIP-39 mnemonic. Call this once after
 * wallet-backup.ts hands you the decrypted seed, or after a fresh mnemonic
 * is generated for first-time users.
 */
export async function sparkInitFromMnemonic(args: {
  mnemonic: string;
  ownerPubkey: string;
  network?: 'mainnet' | 'testnet';
}): Promise<void> {
  // TODO(spark-sdk): wire the real SDK init.
  //
  //   const { connect, defaultConfig } = await import('@breeztech/breez-sdk-spark');
  //   const config = defaultConfig({
  //     network: args.network ?? 'mainnet',
  //     apiKey: process.env.NEXT_PUBLIC_BREEZ_API_KEY,
  //   });
  //   sdk = await connect({
  //     mnemonic: args.mnemonic,
  //     // WARNING: storageDir keyed on ownerPubkey alone collides if the user
  //     // ever creates a second wallet for the same Nostr identity (e.g.
  //     // disconnect → Create new). The Breez SDK will either reject the
  //     // init or corrupt the existing wallet's state. Before flipping this
  //     // on, switch the suffix to a wallet-specific id — e.g. the first 8
  //     // hex chars of sha256(mnemonic) — so each seed gets its own dir:
  //     //   const walletId = sha256(args.mnemonic).slice(0, 8);
  //     //   storageDir: `bmb-spark-${args.ownerPubkey.slice(0, 8)}-${walletId}`,
  //     // The SparkWallet UI already confirms the relay-side overwrite; the
  //     // disk-side guard has to live here.
  //     storageDir: `bmb-spark-${args.ownerPubkey.slice(0, 8)}`,
  //     config,
  //   });
  //   activePubkey = args.ownerPubkey;
  //
  // Stub-mode: register the wallet as initialized so the UI surfaces it.
  // Payments still throw (sparkPayInvoice) until the real SDK lands.
  sdk = STUB_SDK;
  activePubkey = args.ownerPubkey;
  notify();
}

/** Pay a BOLT11 invoice via the Spark SDK. Returns the payment preimage. */
export async function sparkPayInvoice(invoice: string): Promise<string> {
  if (!sdk) throw new Error('Spark wallet not initialized');
  // TODO(spark-sdk):
  //   const res = await (sdk as any).sendPayment({ paymentRequest: invoice });
  //   return res.payment.preimage;
  void invoice;
  throw new Error('Spark SDK not yet wired — see TODO in lib/v4v/spark.ts');
}

/**
 * Generate a fresh BIP-39 mnemonic. Stub-mode uses @scure/bip39 directly so
 * the relay backup flow is exercisable before the SDK lands; swap this for
 * the SDK's own helper once wired (the resulting mnemonic should be format-
 * compatible — both produce standard BIP-39 phrases).
 */
export async function sparkGenerateMnemonic(): Promise<string> {
  const { generateMnemonic } = await import('@scure/bip39');
  const { wordlist } = await import('@scure/bip39/wordlists/english.js');
  return generateMnemonic(wordlist);
}

/** Tear down the SDK on sign-out. */
export async function sparkDisconnect(): Promise<void> {
  // TODO(spark-sdk): await (sdk as any)?.disconnect();
  sdk = null;
  activePubkey = null;
  notify();
}
