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
  try {
    // A read, so a retry is safe — see `withNwcClient`.
    const info = await withNwcClient((c) => c.getInfo(), { retry: true });
    return setNwcMethods(info.methods ?? []);
  } catch {
    return nwcGetMethods() ?? [];
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
  // Drop any socket held against the previous wallet. `acquire` also catches a
  // URI change, but only on the next call — this makes it immediate, and a
  // shared client outliving the wallet it authenticates to is worth no window
  // at all.
  disposeNwcClient();
  notify();
  if (!nwcGetMethods()) void nwcFetchCapabilities().catch(() => {});
};
export const loadNwcUri = () => storage.nwcUri.get();
export const clearNwcUri = () => {
  storage.nwcUri.clear();
  storage.nwcMethods.clear();
  cachedNwcMethods = null;
  // MUST be explicit here, not left to `acquire`: with no URI stored, `acquire`
  // throws before it can compare, so a disconnect would otherwise strand the
  // socket until the idle timer happened to fire.
  disposeNwcClient();
  notify();
};
export const hasNwc = () => storage.nwcUri.has();

/**
 * ONE shared NIP-47 client, leased by every caller and closed when idle.
 *
 * **The relay limits how many connections you OPEN, not how many you hold.**
 * That is the correction to the previous design, which gave every call its own
 * socket and closed it in a `finally`. Closing promptly is right and is kept —
 * it just doesn't help, because the cap being hit is a dial rate.
 *
 * Measured from a HAR of three boosts: 28 connections to `relay.getalby.com` in
 * 83 seconds, of which 19 upgraded and the rest came back
 * **`429 Too Many Requests` with `Retry-After: 600`** — Cloudflare, in front of
 * the relay, refusing the WebSocket upgrade. From that point publish cannot
 * happen at all, so every leg fails with nothing sent, and the block outlives
 * a page reload by ten minutes. (Which also retires the old "a reload fixes it"
 * note below: the reload never fixed anything, the window expired.)
 *
 * Where 28 came from: on the NWC rail each mounted `useWalletBalance` opens one
 * socket for its immediate `nwcGetBalance()` and another for
 * `subscribeNwcNotifications`, and the hook is mounted TWICE during a boost
 * (header chip + boost modal). Add one dial per leg and one per mount per
 * debounced refresh and a three-leg boost cost ~8. Sharing one client makes
 * that ~1: the notification lease holds the socket open, and every balance read
 * and every payment rides it.
 *
 * `NWCClient`'s constructor does `this.relay = new Relay(url)` and nostr-tools
 * does NOT dedupe by URL — deduping lives in `SimplePool`, which the Alby SDK
 * doesn't use — so without this there is no sharing anywhere in the stack.
 *
 * Three rules keep the sharing safe:
 *
 *   - **Refcounted, with an idle close.** The socket goes away once nothing
 *     holds it, so a signed-in idle tab isn't pinning a connection forever, and
 *     `enableReconnect` being false can't strand us on a dead one indefinitely.
 *   - **A URI change disposes it immediately.** Otherwise a reconnect to a
 *     different wallet would keep paying from the old one.
 *   - **A suspect socket is discarded, never reused — but a PAYMENT is never
 *     retried on one.** See `withNwcClient`.
 */
const IDLE_CLOSE_MS = 10_000;

interface SharedClient {
  c: nwc.NWCClient;
  uri: string;
  refs: number;
  idle: ReturnType<typeof setTimeout> | null;
}

let shared: SharedClient | null = null;

function closeShared(s: SharedClient) {
  if (s.idle) clearTimeout(s.idle);
  try { s.c.close(); } catch { /* already closed / never opened */ }
}

/** Drop the shared client now — a URI change, a disconnect, or a bad socket. */
export function disposeNwcClient() {
  if (!shared) return;
  const s = shared;
  shared = null; // clear first: `release` compares identity and must not re-enter
  closeShared(s);
}

interface Lease {
  c: nwc.NWCClient;
  release: () => void;
  /** Drop the underlying socket so the next lease dials fresh. */
  discard: () => void;
}

function acquire(): Lease {
  const uri = loadNwcUri();
  if (!uri) throw new Error('No NWC URI configured');
  // A different wallet than the one we're holding: never pay from the old one.
  if (shared && shared.uri !== uri) disposeNwcClient();
  if (!shared) {
    shared = { c: new nwc.NWCClient({ nostrWalletConnectUrl: uri }), uri, refs: 0, idle: null };
  }
  const held = shared;
  if (held.idle) { clearTimeout(held.idle); held.idle = null; }
  held.refs += 1;

  let done = false;
  return {
    c: held.c,
    release: () => {
      if (done) return; // idempotent: callers release in a `finally`
      done = true;
      if (held !== shared) return; // already disposed by someone else
      held.refs -= 1;
      if (held.refs > 0) return;
      held.idle = setTimeout(() => {
        if (shared === held && held.refs <= 0) disposeNwcClient();
      }, IDLE_CLOSE_MS);
    },
    discard: () => {
      if (held === shared) disposeNwcClient();
    },
  };
}

/**
 * True when a failure suggests the SOCKET is bad rather than the wallet
 * declining. A publish timeout means the request never reached the relay, which
 * is exactly what a dead or refused connection looks like.
 *
 * Deliberately does NOT include a reply timeout: that one means the request WAS
 * published and the wallet may have paid, so the socket is fine and the leg is
 * indeterminate — see `NwcIndeterminateError`.
 */
function isSocketSuspect(e: unknown): boolean {
  if (e instanceof nwc.Nip47PublishTimeoutError) return true;
  const msg = e instanceof Error ? e.message : '';
  return /not connected|connection|websocket|socket closed/i.test(msg);
}

/**
 * Run one NIP-47 request on the shared client.
 *
 * `retry` is **opt-in and only ever safe for reads.** Retrying a payment is a
 * double-spend: a publish that landed and then failed to answer has already
 * moved the sats, and nothing on this side can tell that apart from one that
 * never left. So `nwcPayInvoice` and `nwcKeysend` pass nothing here — they
 * discard a suspect socket so the NEXT leg dials fresh, and let the current leg
 * fail honestly. Losing a leg is recoverable; paying twice is not.
 */
async function withNwcClient<T>(
  fn: (c: nwc.NWCClient) => Promise<T>,
  opts: { retry?: boolean } = {},
): Promise<T> {
  const lease = acquire();
  try {
    return await fn(lease.c);
  } catch (e) {
    if (!isSocketSuspect(e)) throw e;
    lease.discard();
    if (!opts.retry) throw e;
    const fresh = acquire();
    try {
      return await fn(fresh.c);
    } finally {
      fresh.release();
    }
  } finally {
    lease.release();
  }
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
  try {
    // NO `retry`. A publish that landed and then failed to answer has already
    // moved the sats, and nothing here can tell that from one that never left.
    const res = await withNwcClient((c) => c.payInvoice({ invoice }));
    return res.preimage;
  } catch (e) {
    throw mapNwcError(e);
  }
}

/**
 * Fetch the wallet's current balance in sats. NIP-47 returns msats; we floor
 * to whole sats. Returns null on any error (network failure, capability not
 * granted on this connection, wallet down) — callers should hide the chip
 * rather than show a stale or zero value.
 */
export async function nwcGetBalance(): Promise<number | null> {
  try {
    // The most frequently called of the lot — `useWalletBalance` refreshes on
    // every `payment_sent` push and the hook is mounted twice during a boost —
    // and so the one that used to dial the most sockets. It now rides whichever
    // client the notification subscription is already holding open. A read, so
    // a retry is safe.
    const res = await withNwcClient((c) => c.getBalance(), { retry: true });
    const msat = Number(res?.balance ?? 0);
    if (!Number.isFinite(msat) || msat < 0) return null;
    return Math.floor(msat / 1000);
  } catch {
    return null;
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
  let lease: Lease | null = null;
  try {
    lease = acquire();
    const held = lease;
    const unsub = await held.c.subscribeNotifications(onNotification, [
      'payment_received',
      'payment_sent',
    ]);
    // The LONG-LIVED lease, and the one that makes the sharing pay off: it is
    // held for the life of the subscription, so the socket stays open and every
    // balance read and every payment leg rides it instead of dialing. Two
    // mounted hooks now take two leases on ONE connection rather than opening
    // two of their own.
    //
    // The SDK's unsub stops its reconnect loop and closes the NIP-47
    // subscription but NOT the relay, so releasing the lease is what eventually
    // frees the socket — after the idle window, and only if nothing else holds
    // it.
    return () => {
      try { unsub(); } catch { /* ignore */ }
      held.release();
    };
  } catch {
    // `subscribeNotifications` can reject after the socket is already open.
    lease?.release();
    return () => {};
  }
}

export async function nwcKeysend(args: {
  pubkey: string;
  amount_msat: number;
  tlv_records?: { type: number; value: string }[];
}): Promise<string> {
  // Generate a random preimage and pass it explicitly. Some NWC wallets
  // (Zeus embedded node) require the client to supply the preimage rather
  // than auto-generating it; wallets that auto-generate their own will
  // ignore this and return their preimage in res.preimage.
  const preimage = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  try {
    // NO `retry`, for the same reason as `nwcPayInvoice`: this may already have
    // paid. A suspect socket is still discarded, so the next leg dials fresh.
    const res = await withNwcClient((c) => c.payKeysend({
      pubkey: args.pubkey,
      amount: args.amount_msat,
      preimage,
      tlv_records: args.tlv_records ?? [],
    }));
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
  }
}
