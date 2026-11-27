'use client';

import { createObservable } from '../pubsub';
import { BRAND } from '../brand';
import { isNativeIos } from '../native/platform';
import { sparkAccountNumber } from './spark-derive';
import { logPlayback } from '../playback-log';
import { getErrorMessage, sparkErrorCode, type SparkErrorCode } from '../util';

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
const { subscribe: subscribeSpark, notify } = createObservable();

/** Subscribe to wallet state changes. Returns an unsubscribe fn. */
export { subscribeSpark };

/**
 * The last Spark failure that nobody was shown, so the wallet window can say it
 * (#304). Two of them were HIDDEN until 2026-11-27:
 *
 * - `connect`: the page-load restore runs `sparkInitFromMnemonic` under a
 *   `.catch(() => {})`, so a wallet that did not open left no trace. The person
 *   saw the Spark row of the picker as if they had never had a wallet.
 * - `balance`: `sparkGetInfo` answers `null` for any failure, and its callers
 *   read `null` as "no reading yet", so the card showed "—" forever.
 *
 * Each failure goes three ways: `console.warn` with the error's own text (it
 * stays on the device), one line in the bug report's log with a FIXED reason
 * word (`sparkErrorCode`, never the text: the log is filed into a public
 * issue), and this record for `<SparkWallet>` to render.
 *
 * Its OWN observable, not `notify()`: the wallet listeners re-read the balance
 * on `subscribeSpark`, so a failed read that notified them would ask again and
 * fail again. A repeat of the same op and reason word writes no new log line
 * or warning — the SDK's text differs on every call (it carries per-request
 * detail), so comparing it wrote one line per retry (measured: six lines for
 * two refreshes); the card still shows the newest text. A success clears it;
 * so does `sparkDisconnect`, so a signed-out account's failure is not shown to
 * the next.
 */
export type SparkFailure = { op: 'connect' | 'balance'; code: SparkErrorCode; detail: string };
let lastFailure: SparkFailure | null = null;
let lastFailureError: unknown = null;
const failures = createObservable();
export const subscribeSparkFailure = failures.subscribe;
export function sparkLastFailure(): SparkFailure | null {
  return lastFailure;
}
/** Was this error already recorded (and so shown by the wallet window)? Lets a form skip saying it twice. */
export function sparkFailureIs(e: unknown): boolean {
  return e != null && e === lastFailureError;
}
function recordSparkFailure(op: SparkFailure['op'], e: unknown): void {
  const detail = getErrorMessage(e, 'unknown error').slice(0, 300);
  const code = sparkErrorCode(detail);
  lastFailureError = e;
  const repeat = !!lastFailure && lastFailure.op === op && lastFailure.code === code;
  if (repeat && lastFailure!.detail === detail) return;
  lastFailure = { op, code, detail };
  if (!repeat) {
    console.warn(`[spark] ${op} failed (${code}):`, detail);
    logPlayback(`spark.${op}`, { res: 'fail', why: code });
  }
  failures.notify();
}
function clearSparkFailure(op?: SparkFailure['op']): void {
  if (!lastFailure || (op && lastFailure.op !== op)) return;
  lastFailure = null;
  lastFailureError = null;
  failures.notify();
}

/**
 * False inside the iOS app: Spark is a wallet this app HOLDS, and the iOS app
 * holds no funds — it pays through NWC only (docs/wallets.md, "Spark is off
 * inside the iOS app"). `sparkInitFromMnemonic` refuses on it, which stops
 * every path that starts a wallet; the picker row and the page-load restore
 * read it too, so the app neither offers Spark nor asks to decrypt its seed.
 */
export function sparkAvailable(): boolean {
  return !isNativeIos();
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
 * True when the connected wallet is the one this seed initialized.
 *
 * Deliberately a comparison rather than a `getActiveMnemonic()` accessor — the
 * seed is spending authority, and nothing outside this module has a reason to
 * hold it. Exists so a slow background caller can confirm the wallet it
 * connected is still the active one before doing something destructive (see
 * provision-spark.ts, which must not overwrite a kind:30078 backup belonging
 * to a seed the user pasted mid-flight).
 */
export function sparkSeedIsActive(mnemonic: string): boolean {
  return sdk !== null && activeMnemonic === normalizeSeed(mnemonic);
}

// Bound how long callers wait on SparkWallet.initialize(). The SDK's operator
// handshake retries challenge-based auth internally and can stay pending for
// minutes on a degraded connection — without a cap, the wallet modal's
// "Restoring…" spinner never resolves and never errors. The underlying init
// keeps running past the timeout; if it eventually succeeds it still sets
// `sdk` + notify(), so the UI flips to connected late rather than never.
const SPARK_INIT_TIMEOUT_MS = 30_000;

// Single-flight guard: the login-time auto-restore (nostr-auth doLoadProfile)
// and the manual "Restore from Nostr" button can both call init with the same
// seed. Two CONCURRENT SparkWallet.initialize() runs for one identity key
// fight over Spark's per-identity auth challenges ("Authentication failed
// after retrying expired challenges") and retry-loop — the visible symptom is
// a restore stuck on "Restoring…". Same-seed callers share one initialize;
// a different-seed caller (paste racing the auto-restore) waits for the
// in-flight one to settle, then runs its own init, which replaces the SDK.
let initInFlight: { key: string; promise: Promise<void> } | null = null;
// Normalized seed of the ACTIVE wallet, kept only to make init idempotent
// (re-initing the same seed is a no-op; a different seed re-inits). The seed
// already lives in the SDK instance, so this widens no security boundary.
let activeMnemonic: string | null = null;

const normalizeSeed = (m: string) => m.trim().replace(/\s+/g, ' ');

/**
 * Initialize the Spark SDK from a BIP-39 mnemonic. Call this once after
 * wallet-backup.ts hands you the decrypted seed, after a fresh mnemonic is
 * generated for first-time users, or when the user pastes an existing seed.
 * Idempotent for an already-loaded seed; concurrent same-seed calls share one
 * SDK initialize; the wait is capped at SPARK_INIT_TIMEOUT_MS.
 */
export async function sparkInitFromMnemonic(args: {
  mnemonic: string;
  ownerPubkey: string;
  // Spark supports `mainnet` and `regtest` only — there's no public testnet
  // for Spark. Use `regtest` against a local node for development.
  network?: 'mainnet' | 'regtest';
}): Promise<void> {
  // THE ONE GATE. The picker row, the page-load restore of the seed backup,
  // a local key's derived wallet and the Google new-account branch all start
  // a wallet here, so a check at any one caller leaves the other three open.
  // Before the SDK import: inside the app the Spark SDK is never fetched.
  if (!sparkAvailable()) throw new Error('Spark is not available in the iOS app — connect a wallet with NWC');
  const key = normalizeSeed(args.mnemonic);
  // Already connected with this exact seed — the auto-restore beat a manual
  // restore (or vice versa). Nothing to do.
  if (sdk && activePubkey === args.ownerPubkey && activeMnemonic === key) return;

  while (initInFlight && initInFlight.key !== key) {
    // A different seed is mid-handshake. Let it settle (success or failure)
    // before starting ours — serializing avoids the challenge fight.
    await initInFlight.promise.catch(() => { /* its caller reports the error */ });
  }
  if (!initInFlight) {
    const promise = doInitFromMnemonic(args).finally(() => { initInFlight = null; });
    // Branch handler so a rejection after every racer timed out doesn't
    // surface as an unhandled-rejection; racers awaiting `promise` itself
    // still see the real error.
    promise.catch(() => {});
    initInFlight = { key, promise };
  }
  const pending = initInFlight.promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Spark connection timed out — check your network and try again')),
      SPARK_INIT_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([pending, timeout]);
  } catch (e) {
    // `doInitFromMnemonic` records its own failure once for every racer; this
    // records the cap, which only the wrapper sees.
    if (!sparkFailureIs(e)) recordSparkFailure('connect', e);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function doInitFromMnemonic(args: {
  mnemonic: string;
  ownerPubkey: string;
  network?: 'mainnet' | 'regtest';
}): Promise<void> {
  let wallet: unknown;
  try {
    // Dynamic import keeps the heavy SDK out of the initial bundle.
    const { SparkWallet } = await import('@buildonspark/spark-sdk');

    const network = args.network ?? 'mainnet';
    ({ wallet } = await SparkWallet.initialize({
      mnemonicOrSeed: args.mnemonic,
      // Spark's per-network DEFAULT account number is 1 on mainnet, 0 on regtest.
      // Primal and BlitzWallet both use that default, so we mirror it explicitly
      // to derive the SAME account (and therefore share the balance) for a given
      // seed. Hardcoding 0 on mainnet derives a different, empty account.
      // Pinned with the installed SDK by `npm run check:spark`.
      accountNumber: sparkAccountNumber(network),
      options: { network: network === 'regtest' ? 'REGTEST' : 'MAINNET' },
    }));
  } catch (e) {
    // Once per init, whoever is waiting: the racers share this promise.
    recordSparkFailure('connect', e);
    throw e;
  }

  sdk = wallet as unknown as SparkSdk;
  activePubkey = args.ownerPubkey;
  activeMnemonic = normalizeSeed(args.mnemonic);
  // Also after a timeout the wrapper recorded: the init went on and opened.
  clearSparkFailure();
  notify();
}

/**
 * Pay a BOLT11 invoice via the Spark SDK. The preimage is NOT returned
 * synchronously by payLightningInvoice, so we return '' — BoostResult.preimage
 * is optional and unread by the UI. `maxFeeSats`: a boost leg allows 100; a
 * note stamp passes its own cap (STAMP_MAX_FEE_SATS).
 */
export async function sparkPayInvoice(invoice: string, maxFeeSats = 100): Promise<string> {
  if (!sdk) throw new Error('Spark wallet not initialized');
  await sdk.payLightningInvoice({ invoice, maxFeeSats });
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

// Derives the wallet mnemonic from a Nostr secret key (see the ⚠️ derivation-
// contract block in spark-derive.ts). It lives in its own file because this
// module can't be loaded from plain Node — 'use client' plus the extensionless
// '../pubsub' import — and that derivation needs a check script able to import
// and run the real thing. Re-exported here so every call site keeps importing
// it from `@/lib/v4v/spark`.
export { sparkMnemonicFromKey } from './spark-derive';

/** Tear down the SDK on sign-out. */
export async function sparkDisconnect(): Promise<void> {
  if (sdk) {
    try { await sdk.cleanup(); } catch { /* best effort */ }
  }
  sdk = null;
  activePubkey = null;
  activeMnemonic = null;
  clearSparkFailure();
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
    clearSparkFailure('balance');
    return { balanceSats: Number(sats) };
  } catch (e) {
    // Still `null` to the callers (they read it as "no reading"), but no longer
    // silent: see `SparkFailure`.
    recordSparkFailure('balance', e);
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
    memo: args.description ?? `${BRAND.wireName} Spark deposit`,
  });
  return {
    invoice: String(res?.invoice?.encodedInvoice ?? ''),
    feeSats: 0,
  };
}
