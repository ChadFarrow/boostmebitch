'use client';

// Spark rail — Spark Labs SDK adapter (@buildonspark/spark-sdk). Self-custodial
// wallet whose mnemonic is bootstrapped from a NIP-44-encrypted backup on Nostr
// relays (lib/nostr/wallet-backup.ts).
//
// We use the SDK's per-network DEFAULT account number (1 on mainnet, 0 on
// regtest) so the SAME seed phrase yields the SAME balance as Primal and
// BlitzWallet, which both use that default — see CLAUDE.md.
//
// Send capabilities: BOLT11 invoices only. Keysend is NOT supported by this
// rail — node-pubkey value-block legs degrade in lib/v4v/boost.ts. lnaddress
// legs work because payOne fetches a BOLT11 from the LNURL-pay endpoint first.
//
// Init is dynamic-imported inside sparkInitFromMnemonic so the heavy SDK
// payload only lands in the bundle the first time a user actually opens a
// Spark wallet.

// SDK instance is loosely typed because the SDK's generated bindings change
// across minor versions; we pin the public surface (hasSpark / sparkPayInvoice /
// sparkDisconnect / …) and let TypeScript validate at the call boundary.
type SparkSdk = {
  payLightningInvoice: (req: { invoice: string; maxFeeSats?: number }) => Promise<unknown>;
  createLightningInvoice: (req: {
    amountSats: number;
    memo?: string;
  }) => Promise<{ invoice?: { encodedInvoice?: string } }>;
  getBalance: () => Promise<{ balance?: bigint; satsBalance?: { available?: bigint } }>;
  cleanup: () => Promise<void>;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

// Consumer-facing event union. Kept intentionally stable across the Breez →
// Spark Labs swap so components don't change: subscribeSparkEvents maps the
// SDK's eventemitter3 events into these `type` discriminants. Some variants
// (e.g. `newDeposits`) are no longer emitted by this SDK — they're harmless
// dead arms in consumers' switch statements.
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
 * wallet-backup.ts hands you the decrypted seed, after a fresh mnemonic is
 * generated for first-time users, or when the user pastes an existing seed.
 */
export async function sparkInitFromMnemonic(args: {
  mnemonic: string;
  ownerPubkey: string;
  // Spark supports `mainnet` and `regtest` only — there's no public testnet
  // for Spark. Use `regtest` against a local node for development.
  network?: 'mainnet' | 'regtest';
}): Promise<void> {
  // Dynamic import keeps the heavy SDK out of the initial bundle.
  const { SparkWallet } = await import('@buildonspark/spark-sdk');

  const { wallet } = await SparkWallet.initialize({
    mnemonicOrSeed: args.mnemonic,
    // Spark's per-network DEFAULT account number is 1 on mainnet, 0 on regtest.
    // Primal and BlitzWallet both use that default, so we mirror it explicitly
    // to derive the SAME account (and therefore share the balance) for a given
    // seed. Hardcoding 0 on mainnet derives a different, empty account.
    accountNumber: args.network === 'regtest' ? 0 : 1,
    options: { network: args.network === 'regtest' ? 'REGTEST' : 'MAINNET' },
  });

  sdk = wallet as unknown as SparkSdk;
  activePubkey = args.ownerPubkey;
  notify();
}

/**
 * Pay a BOLT11 invoice via the Spark SDK. The preimage is NOT returned
 * synchronously by payLightningInvoice, so we return '' — BoostResult.preimage
 * is optional and unread by the UI.
 */
export async function sparkPayInvoice(invoice: string): Promise<string> {
  if (!sdk) throw new Error('Spark wallet not initialized');
  await sdk.payLightningInvoice({ invoice, maxFeeSats: 100 });
  return '';
}

/**
 * Generate a fresh BIP-39 mnemonic. Uses @scure/bip39 directly — it's already
 * on disk via nostr-tools and produces SDK-compatible output, so we don't pay
 * the SDK init cost just to mint a phrase.
 */
export async function sparkGenerateMnemonic(): Promise<string> {
  const { generateMnemonic } = await import('@scure/bip39');
  const { wordlist } = await import('@scure/bip39/wordlists/english.js');
  return generateMnemonic(wordlist);
}

/** Tear down the SDK on sign-out. */
export async function sparkDisconnect(): Promise<void> {
  if (sdk) {
    try { await sdk.cleanup(); } catch { /* best effort */ }
  }
  sdk = null;
  activePubkey = null;
  notify();
}

/** Fetch the wallet's current balance in sats. */
export async function sparkGetInfo(): Promise<{ balanceSats: number; identityPubkey?: string } | null> {
  if (!sdk) return null;
  try {
    const b = await sdk.getBalance();
    // satsBalance.available is the immediately-spendable balance; `balance` is
    // the deprecated alias for the same number. Both are bigint.
    const sats = b?.satsBalance?.available ?? b?.balance ?? 0n;
    return { balanceSats: Number(sats) };
  } catch {
    return null;
  }
}

/**
 * Subscribe to SDK events. Maps the SDK's eventemitter3 events into the
 * consumer-facing SparkSdkEvent union and returns an unsubscribe fn. Use this
 * instead of polling getInfo.
 */
export async function subscribeSparkEvents(
  onEvent: (e: SparkSdkEvent) => void,
): Promise<() => void> {
  if (!sdk) return () => {};
  const active = sdk;

  // An incoming lightning payment to a deposit invoice surfaces as a claimed
  // transfer; treat it as a successful payment so ReadyPanel clears the open
  // invoice and refreshes.
  const onTransferClaimed = () => onEvent({ type: 'paymentSucceeded', payment: undefined });
  // On-chain deposits confirming → claimedDeposits (also clears the invoice).
  const onDepositConfirmed = () => onEvent({ type: 'claimedDeposits', claimedDeposits: [] });
  // General balance changes + stream (re)connect → a plain refresh.
  const onBalanceUpdate = () => onEvent({ type: 'synced' });
  const onStreamConnected = () => onEvent({ type: 'synced' });

  active.on('transfer:claimed', onTransferClaimed);
  active.on('deposit:confirmed', onDepositConfirmed);
  active.on('balance:update', onBalanceUpdate);
  active.on('stream:connected', onStreamConnected);

  return () => {
    active.off('transfer:claimed', onTransferClaimed);
    active.off('deposit:confirmed', onDepositConfirmed);
    active.off('balance:update', onBalanceUpdate);
    active.off('stream:connected', onStreamConnected);
  };
}

/**
 * Generate a BOLT11 invoice the user can pay from any other Lightning wallet
 * to fund this Spark wallet. The Spark SDK doesn't surface a settle fee here,
 * so feeSats is always 0 (ReadyPanel hides the fee line when it's 0).
 */
export async function sparkReceiveInvoice(args: {
  amountSats?: number;
  description?: string;
}): Promise<{ invoice: string; feeSats: number }> {
  if (!sdk) throw new Error('Spark wallet not initialized');
  const res = await sdk.createLightningInvoice({
    amountSats: args.amountSats ?? 0,
    memo: args.description ?? 'BoostMeBitch Spark deposit',
  });
  return {
    invoice: String(res?.invoice?.encodedInvoice ?? ''),
    feeSats: 0,
  };
}
