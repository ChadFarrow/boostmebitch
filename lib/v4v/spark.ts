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

let sdk: SparkSdk | null = null;
let activePubkey: string | null = null;

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
  //     storageDir: `bmb-spark-${args.ownerPubkey.slice(0, 8)}`,
  //     config,
  //   });
  //   activePubkey = args.ownerPubkey;
  //
  // Until then, mark the wallet as "not ready" so callers fall through to
  // NWC/WebLN.
  void args;
  throw new Error('Spark SDK not yet wired — see TODO in lib/v4v/spark.ts');
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
 * Generate a fresh BIP-39 mnemonic for first-time wallet setup. Implementation
 * detail of the SDK; until wired, callers can supply their own mnemonic from
 * @scure/bip39 if they want to test the relay backup flow without the SDK.
 */
export async function sparkGenerateMnemonic(): Promise<string> {
  // TODO(spark-sdk): use the SDK's mnemonic helper, or import from @scure/bip39.
  //   const { generateMnemonic, wordlist } = await import('@scure/bip39/wordlists/english');
  //   return generateMnemonic(wordlist);
  throw new Error('Spark mnemonic generator not yet wired');
}

/** Tear down the SDK on sign-out. */
export async function sparkDisconnect(): Promise<void> {
  // TODO(spark-sdk): await (sdk as any)?.disconnect();
  sdk = null;
  activePubkey = null;
}
