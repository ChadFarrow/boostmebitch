// The SDK-free half of the NWC rail: what a component may read during render,
// and what any module may import WITHOUT pulling `@getalby/sdk` into its chunk.
//
// `lib/v4v/nwc.ts` imports the SDK at module top level, and it was reachable
// statically from the root layout by four paths (`<Player>` → streaming.ts →
// boost.ts → nwc.ts; `<Player>` → <BoostModal> → boost.ts; <WalletModalHost> →
// wallet-modal.tsx → nwc-wallet.tsx; wallet-modal.tsx → wallets.ts). So the
// NIP-47 client — 110 KB raw, ~36 KB gzip — shipped in the first load of every
// route, including for a visitor with no wallet at all. Everything the initial
// graph actually needs from the rail is here: "is a wallet connected", the
// stored URI, the cached method list, the connect/disconnect writers and the
// observable that tells the header chip and the rail picker to re-read. The
// SDK-bearing half stays in nwc.ts and is `import()`ed where a payment or a
// balance read happens.
//
// `saveNwcUri` / `clearNwcUri` live HERE, not in nwc.ts, because their callers
// are synchronous and in the first load (sign-in restores a URI, sign-out
// clears it). The two things they need from the SDK half — dispose the shared
// client, prefetch the wallet's capabilities — are hooks nwc.ts registers when
// it loads. When it has not loaded there is no client to dispose and the
// capability prefetch simply waits for the first boost, which fetches it
// anyway (`railCanKeysend`). The order inside each writer is unchanged:
// write → dispose → notify → prefetch.
import { storage } from '../storage';
import { createObservable } from '../pubsub';

// Components reading hasNwc() during render need to refresh when an outside
// actor flips the connect state — most commonly the wallet modal showing the
// connect form alongside another component reading the same flag. The Spark
// rail uses the same pattern (lib/v4v/spark.ts:subscribeSpark).
const { subscribe: subscribeNwc, notify: notifyNwc } = createObservable();
export { subscribeNwc, notifyNwc };

export const hasNwc = () => storage.nwcUri.has();
export const loadNwcUri = () => storage.nwcUri.get();

// Cached methods list from the last successful get_info call. Populated by
// nwcValidate (at connect time) and nwcFetchCapabilities (lazy on card mount).
// Null means "we don't know" — and so does an EMPTY list, deliberately: see
// nwcGetMethods.
let cachedNwcMethods: string[] | null = null;

/**
 * Record the method list both in memory and in localStorage, tagged with the
 * URI it belongs to. Connect-time validation is the main writer: capturing it
 * there means the boost path never has to ask the wallet what it can do.
 *
 * `uri` is passed explicitly during validation because the connection hasn't
 * been saved yet at that point.
 *
 * An empty list is deliberately NOT persisted. It carries no information (the
 * wallet answered but told us nothing), and writing it created a permanent
 * latch: the persisted `[]` read back as a settled answer, so the connection
 * could never be re-probed for the life of that URI.
 */
export function setNwcMethods(methods: string[], uri?: string): string[] {
  cachedNwcMethods = methods;
  const target = uri ?? loadNwcUri();
  if (target && methods.length) storage.nwcMethods.set({ uri: target, methods });
  return methods;
}

/**
 * Supported NIP-47 methods for the current connection, or null when we don't
 * know. Falls back to the persisted record so the answer survives a page
 * reload — but only when it was captured for the URI that's connected now, so
 * switching wallets can't inherit the old one's capabilities.
 *
 * **An empty list counts as "don't know," not "fetched, empty."** Some wallets
 * omit `methods` from their `get_info` response entirely, and `[]` is truthy
 * in JS — so returning it here handed callers a confident "this wallet can do
 * nothing," permanently disabling the keysend upgrade for a wallet that may
 * well support it. Callers that need certainty must treat null as unknown and
 * decide for themselves (see railCanKeysend's tri-state).
 */
export const nwcGetMethods = (): string[] | null => {
  if (cachedNwcMethods?.length) return cachedNwcMethods;
  const rec = storage.nwcMethods.get();
  const uri = loadNwcUri();
  if (!rec || !uri || rec.uri !== uri || !rec.methods.length) return null;
  cachedNwcMethods = rec.methods;
  return cachedNwcMethods;
};

/** What the SDK half does on a URI change, once it has loaded. */
interface NwcClientHooks {
  /** Drop the shared client and any per-wallet cache. */
  reset(): void;
  /** Fire-and-forget `get_info`, so the first boost never has to ask. */
  prefetchCapabilities(): void;
}
let clientHooks: NwcClientHooks | null = null;
export function registerNwcClientHooks(hooks: NwcClientHooks): void {
  clientHooks = hooks;
}

// Every connect path funnels through here — paste, the Nostr-backup auto
// restore, the manual restore button, and the login-time restore in
// loadProfile — so this is where we make sure the wallet's capabilities are
// settled at connect rather than during a boost. The prefetch is
// fire-and-forget: a failure just defers the question to the first boost. The
// guard makes it a no-op on the paste path, where nwcValidate already
// recorded the methods for this URI.
export const saveNwcUri = (uri: string) => {
  storage.nwcUri.set(uri);
  cachedNwcMethods = null;
  // Drop any socket held against the previous wallet. `acquire` also catches a
  // URI change, but only on the next call — this makes it immediate, and a
  // shared client outliving the wallet it authenticates to is worth no window
  // at all.
  clientHooks?.reset();
  notifyNwc();
  if (!nwcGetMethods()) clientHooks?.prefetchCapabilities();
};

export const clearNwcUri = () => {
  storage.nwcUri.clear();
  storage.nwcMethods.clear();
  cachedNwcMethods = null;
  // MUST be explicit here, not left to `acquire`: with no URI stored, `acquire`
  // throws before it can compare, so a disconnect would otherwise strand the
  // socket until the idle timer happened to fire.
  clientHooks?.reset();
  notifyNwc();
};

// Set whenever a connection is restored from the Nostr backup (login-time,
// form auto-check, or the manual button). The connected card shows a one-time
// "✓ Restored" confirmation and clears the flag when it unmounts, so the
// notice appears on the first wallet-modal view after a restore and not on
// every open thereafter. Lives here, not in nwc-wallet.tsx, because sign-in
// sets it — and a sign-in that imported the wallet card imported the SDK.
let restoredFromBackupNpub: string | null = null;
export function markNwcRestored(npub: string): void {
  restoredFromBackupNpub = npub;
}
export function wasNwcRestored(npub: string | undefined): boolean {
  return !!npub && restoredFromBackupNpub === npub;
}
export function clearNwcRestored(): void {
  restoredFromBackupNpub = null;
}
