// NWC / NIP-47 payments using @getalby/sdk.
// When v4v-toolkit ships its own NWC client, swap this file's imports.

import { nwc } from '@getalby/sdk';
import { storage } from '../storage';
import { createObservable } from '../pubsub';

// Components reading hasNwc() during render need to refresh when an outside
// actor flips the connect state — most commonly the wallet modal showing the
// connect form alongside another component reading the same flag. The Spark
// rail uses the same pattern (lib/v4v/spark.ts:subscribeSpark).
const { subscribe: subscribeNwc, notify } = createObservable();
export { subscribeNwc };

/**
 * Thrown when the wallet answers a NIP-47 request with `NOT_IMPLEMENTED`.
 *
 * Load-bearing as a *type*, not just a message: the wallet returns this error
 * **instead of** executing the payment, so nothing left the wallet and the
 * caller may safely retry the leg by another route. `boost.ts` keys its one
 * permitted keysend→LNURL fallback off `instanceof` this. Flattening it back
 * into a plain Error (as this code used to) makes a wallet that can't keysend
 * indistinguishable from a routing failure that may already have paid — and
 * the fallback would then be a double-pay.
 */
export class NwcMethodUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NwcMethodUnsupportedError';
  }
}

/**
 * Thrown when the request reached the wallet's relay but no reply came back
 * inside the SDK's 60 s cap.
 *
 * **This is not a failure, and reporting it as one is a money bug.** The
 * request was published; the wallet may have executed the payment and simply
 * answered late, or not at all. Observed live against AlbyHub: every leg of a
 * boost showed ✗ in the modal while Alby pushed "Sent 10 sats" notifications
 * for each one and the recipient's wallet showed the sats arriving two minutes
 * later. A ✗ invites the user to boost again, and a re-boost repeats EVERY
 * leg — including the ones that already paid. Losing sats is recoverable;
 * sending them twice is not.
 *
 * The exact inverse of `NwcMethodUnsupportedError`, and the pair is worth
 * holding together: NOT_IMPLEMENTED is the wallet answering *instead of*
 * paying, so it proves nothing moved and the leg may be retried elsewhere. A
 * reply timeout proves nothing at all, so the leg must NOT be retried and must
 * NOT be called failed.
 *
 * Deliberately NOT raised for `Nip47PublishTimeoutError` — that one means the
 * request never reached the relay, so no payment can have happened and an
 * ordinary failure is the honest answer.
 */
export class NwcIndeterminateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NwcIndeterminateError';
  }
}

const NOT_IMPLEMENTED_MSG =
  'Wallet returned NOT_IMPLEMENTED — your NWC wallet may not support this payment type. Try Alby or Mutiny instead of an embedded node.';

const TIMEOUT_MSG =
  'Wallet did not answer in time — this payment may still have been sent. Check your wallet before boosting again.';

/** Map the SDK's typed errors into ours; pass anything else through. */
function mapNwcError(e: unknown): unknown {
  if (e instanceof nwc.Nip47WalletError && e.code === 'NOT_IMPLEMENTED') {
    return new NwcMethodUnsupportedError(NOT_IMPLEMENTED_MSG);
  }
  // Reply timeout only. Nip47PublishTimeoutError extends the same parent but
  // means the opposite thing, so match the leaf class, not Nip47TimeoutError.
  if (e instanceof nwc.Nip47ReplyTimeoutError) {
    return new NwcIndeterminateError(TIMEOUT_MSG);
  }
  return e;
}

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
function setNwcMethods(methods: string[], uri?: string): string[] {
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

/** Fetch and cache the wallet's supported methods. No-op if not connected. */
export async function nwcFetchCapabilities(): Promise<string[]> {
  if (!hasNwc()) return [];
  let c: ReturnType<typeof client> | null = null;
  try {
    c = client();
    const info = await c.getInfo();
    return setNwcMethods(info.methods ?? []);
  } catch {
    return nwcGetMethods() ?? [];
  } finally {
    // Matches nwcValidate — this now runs on every connect, so leaving the
    // relay socket open each time would accumulate them.
    try { c?.close(); } catch { /* ignore */ }
  }
}

// Re-export the URI accessors so existing call sites keep their imports.
// Drops the in-memory list only. The persisted record is uri-tagged, so if
// this save is the one that follows nwcValidate (same URI) the connect-time
// capability is still readable; a genuinely different URI won't match it.
//
// Every connect path funnels through here — paste, the Nostr-backup auto
// restore, the manual restore button, and the login-time restore in
// loadProfile — so this is where we make sure the wallet's capabilities are
// settled at connect rather than during a boost. Fire-and-forget: it's a
// prefetch, and a failure just defers the question to the first boost. The
// guard makes it a no-op on the paste path, where nwcValidate already
// recorded the methods for this URI.
export const saveNwcUri = (uri: string) => {
  storage.nwcUri.set(uri);
  cachedNwcMethods = null;
  notify();
  if (!nwcGetMethods()) void nwcFetchCapabilities().catch(() => {});
};
export const loadNwcUri = () => storage.nwcUri.get();
export const clearNwcUri = () => {
  storage.nwcUri.clear();
  storage.nwcMethods.clear();
  cachedNwcMethods = null;
  notify();
};
export const hasNwc = () => storage.nwcUri.has();

/**
 * A fresh NIP-47 client — **and therefore a fresh WebSocket. Every caller MUST
 * close it, in a `finally`.**
 *
 * This is not hygiene, it is the money path. `NWCClient`'s constructor does
 * `this.relay = new Relay(url)`, and nostr-tools does NOT dedupe by URL —
 * deduping lives in `SimplePool`, which the Alby SDK doesn't use. So one call
 * here is one socket, `NWCClient.close()` is the only thing that tears it down,
 * and `executeNip47Request` closes only its *subscription*, never the relay.
 * The relay is also constructed with no options, so `enableReconnect` is false
 * and there is no keepalive ping: an unclosed socket sits half-open forever,
 * still counting against the relay's per-connection cap.
 *
 * Four of the five call sites used to leak, and it degraded in two stages
 * within a single page session — each worse than a plain outage:
 *
 *   1. The relay still accepts connections but starves REQ on the over-limit
 *      ones. `relay.publish` lands, so **the wallet pays**, while the kind:23195
 *      reply never routes back — every leg reports failure on a payment that
 *      went through. Re-boosting then pays twice.
 *   2. The relay refuses outright. `_checkConnected`/publish fails, nothing is
 *      sent, and every leg fails fast on the 5 s publish cap.
 *
 * Observed live: 1 failed leg of 3, then 2 of 5, then 5 of 5 with no payments
 * at all, across ~20 minutes without a reload. A reload "fixed" it, which is
 * exactly what a leak looks like from the outside.
 *
 * `subscribeNwcNotifications` is the long-lived exception and closes its client
 * from the returned unsub — see the wrapper there.
 */
function client() {
  const uri = loadNwcUri();
  if (!uri) throw new Error('No NWC URI configured');
  return new nwc.NWCClient({ nostrWalletConnectUrl: uri });
}

/**
 * Validate an NWC URI by opening a client against it and round-tripping
 * a read-only request to the wallet's relay. Catches malformed URIs, dead
 * relays, and wrong secrets at connect time instead of silently failing
 * on the first boost.
 *
 * Tries `get_info` first, then `get_balance` — some per-app NWC connections
 * only grant one or the other. Either is enough to confirm the relay +
 * secret combo works. Returns null on success, an error message on
 * failure. Does not save the URI.
 */
export async function nwcValidate(uri: string): Promise<string | null> {
  let c: nwc.NWCClient;
  try {
    c = new nwc.NWCClient({ nostrWalletConnectUrl: uri });
  } catch (e) {
    return e instanceof Error ? e.message : 'invalid URI';
  }
  // 20s cap per attempt — NIP-47 relays can take a few seconds for the
  // first round-trip, especially over flaky LTE; shorter would false-
  // negative slow wallets. Two attempts (get_info → get_balance) so the
  // worst-case wait is 40s.
  const withTimeout = <T>(p: Promise<T>) =>
    Promise.race([
      p,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout — wallet did not respond in 20s')), 20000),
      ),
    ]);
  try {
    try {
      const info = await withTimeout(c.getInfo());
      // Captured here, at connect, so the boost path already knows whether
      // this wallet can keysend and never pays for the check mid-payment.
      setNwcMethods(info.methods ?? [], uri);
      return null;
    } catch (infoErr) {
      // get_info may not be granted on this connection. Try get_balance —
      // permission models differ wallet to wallet. If that also fails, we
      // surface the get_balance error since it's the broader-scope check.
      try {
        await withTimeout(c.getBalance());
        return null;
      } catch (balErr) {
        return balErr instanceof Error
          ? balErr.message
          : infoErr instanceof Error
            ? infoErr.message
            : 'wallet did not respond';
      }
    }
  } finally {
    try { c.close(); } catch { /* ignore */ }
  }
}

export async function nwcPayInvoice(invoice: string): Promise<string> {
  const c = client();
  try {
    const res = await c.payInvoice({ invoice });
    return res.preimage;
  } catch (e) {
    throw mapNwcError(e);
  } finally {
    // Must be `finally`, not a line after the await: the catch above rethrows,
    // and a boost pays its legs in a serial loop — leaking one socket per leg is
    // how a five-recipient block saturates a relay inside one session.
    try { c.close(); } catch { /* ignore */ }
  }
}

/**
 * Fetch the wallet's current balance in sats. NIP-47 returns msats; we floor
 * to whole sats. Returns null on any error (network failure, capability not
 * granted on this connection, wallet down) — callers should hide the chip
 * rather than show a stale or zero value.
 */
export async function nwcGetBalance(): Promise<number | null> {
  let c: ReturnType<typeof client> | null = null;
  try {
    c = client();
    const res = await c.getBalance();
    const msat = Number(res?.balance ?? 0);
    if (!Number.isFinite(msat) || msat < 0) return null;
    return Math.floor(msat / 1000);
  } catch {
    return null;
  } finally {
    // The biggest leaker of the four, because it is the most frequently called:
    // `useWalletBalance` refreshes on every `payment_sent` push, and the hook is
    // mounted twice during a boost (header chip + boost modal), so each paid leg
    // used to strand two more sockets on top of the payment's own.
    try { c?.close(); } catch { /* ignore */ }
  }
}

/**
 * Subscribe to NIP-47 push notifications for `payment_received` /
 * `payment_sent`. Many wallets support this; some don't. Returns an unsub
 * fn — a no-op if subscription failed, so callers can rely on it without
 * branching.
 */
export async function subscribeNwcNotifications(
  onNotification: (e: nwc.Nip47Notification) => void,
): Promise<() => void> {
  let c: ReturnType<typeof client> | null = null;
  try {
    c = client();
    const held = c;
    const unsub = await held.subscribeNotifications(onNotification, [
      'payment_received',
      'payment_sent',
    ]);
    // The SDK's unsub stops its reconnect loop and closes the NIP-47
    // subscription — but NOT the relay, so returning it bare stranded a socket
    // that no caller could ever reach: `c` went out of scope here and the SDK
    // exposes no handle to it. This hook mounts twice (header chip + boost
    // modal) and re-runs whenever the rail changes, so every remount used to
    // cost one permanent connection.
    return () => {
      try { unsub(); } catch { /* ignore */ }
      try { held.close(); } catch { /* ignore */ }
    };
  } catch {
    // Close the half-built client too — subscribeNotifications can reject after
    // the socket is already open.
    try { c?.close(); } catch { /* ignore */ }
    return () => {};
  }
}

export async function nwcKeysend(args: {
  pubkey: string;
  amount_msat: number;
  tlv_records?: { type: number; value: string }[];
}): Promise<string> {
  const c = client();
  // Generate a random preimage and pass it explicitly. Some NWC wallets
  // (Zeus embedded node) require the client to supply the preimage rather
  // than auto-generating it; wallets that auto-generate their own will
  // ignore this and return their preimage in res.preimage.
  const preimage = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  try {
    const res = await c.payKeysend({
      pubkey: args.pubkey,
      amount: args.amount_msat,
      preimage,
      tlv_records: args.tlv_records ?? [],
    });
    return res.preimage ?? preimage;
  } catch (e) {
    // Zeus embedded node sometimes succeeds in sending the keysend but returns
    // the NIP-47 result without a preimage field. The SDK's payKeysend validates
    // e => !!e.preimage and throws Nip47ResponseValidationError when the field
    // is absent — even though the payment went through. Since we generated the
    // preimage and passed it, Zeus used it for TLV 5482373484, so our preimage
    // IS the valid proof of payment. Re-throw anything else (routing failures,
    // method-not-supported, timeout) so the caller sees the real error.
    if (e instanceof nwc.Nip47ResponseValidationError) return preimage;
    // NOT_IMPLEMENTED becomes a typed NwcMethodUnsupportedError: the wallet
    // returned it *instead of* paying, which is the one keysend failure
    // boost.ts is allowed to retry over LNURL. Everything else stays opaque
    // precisely because it may have paid already.
    throw mapNwcError(e);
  } finally {
    // `finally` specifically: this catch both RETURNS (the Zeus no-preimage
    // path) and RETHROWS, so a close appended to either one would be skipped by
    // the other.
    try { c.close(); } catch { /* ignore */ }
  }
}
