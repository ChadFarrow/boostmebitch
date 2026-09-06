// NWC / NIP-47 payments using @getalby/sdk.
// When v4v-toolkit ships its own NWC client, swap this file's imports.
//
// **This module is loaded with `import()`, never statically, from anything in
// the first-load graph** — see lib/v4v/nwc-state.ts, which holds the SDK-free
// half (connect state, the URI, the method cache, the observable) and is what
// components and the streaming engine import. `boost.ts` loads this module
// once at the top of `sendBoost`; the balance chip loads it inside its effect;
// `<NwcWallet>` is a `next/dynamic` import. Re-adding a static import of this
// file from a component puts the SDK back into every route's first load.

import { nwc } from '@getalby/sdk';
// The budget arithmetic lives in `lib/util.ts` so `npm run check:nwcbudget`
// can load the shipping functions under plain Node — this module imports the
// SDK (and, through nwc-state, `../storage`) and cannot be loaded that way.
import { parseNwcBudget, spendableSats, type NwcBudget } from '../util';
import { createLeasePool, type Lease } from './lease';
import {
  hasNwc,
  loadNwcUri,
  nwcGetMethods,
  registerNwcClientHooks,
  setNwcMethods,
} from './nwc-state';

// Re-exported so the sites that load this module still find the state half
// under one import.
export { subscribeNwc, hasNwc, loadNwcUri, saveNwcUri, clearNwcUri, nwcGetMethods } from './nwc-state';

// The NIP-47 error classification lives in `nwc-errors.ts` so it can load under
// plain Node and be pinned by `npm run check:nwcerror` — this module imports
// `../storage` and cannot. Every name is RE-EXPORTED here so import sites keep
// one path: `boost.ts` keys the two arms of its keysend→LNURL retry off
// `instanceof NwcNotAttemptedError` and `routingFailureProvesUnpaid`, and its
// address demotion off `failureBlamesDestination`. `isSocketSuspect` is used
// below and not re-exported — nothing outside this module has a lease to
// discard.
import {
  failureBlamesDestination,
  isSocketSuspect,
  mapNwcError,
  NwcIndeterminateError,
  NwcMethodUnsupportedError,
  NwcNotAttemptedError,
  routingFailureProvesUnpaid,
  shouldDemoteAddress,
} from './nwc-errors';

export type { NwcBudget };

export {
  failureBlamesDestination,
  NwcIndeterminateError,
  NwcMethodUnsupportedError,
  NwcNotAttemptedError,
  routingFailureProvesUnpaid,
  shouldDemoteAddress,
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

/**
 * The refcount lives in `lease.ts`, which has NO imports so
 * `npm run check:lease` can pin it against the real thing — this module can't
 * be loaded that way, because it imports `../storage`. The URI is the pool key,
 * so a wallet switch disposes the old client rather than paying from it.
 */
const pool = createLeasePool<nwc.NWCClient>({
  create: (uri) => new nwc.NWCClient({ nostrWalletConnectUrl: uri }),
  close: (c) => c.close(),
  idleMs: IDLE_CLOSE_MS,
});

/** Drop the shared client now — a URI change, a disconnect, or a bad socket. */
export function disposeNwcClient() {
  pool.dispose();
}

function acquire(): Lease<nwc.NWCClient> {
  const uri = loadNwcUri();
  if (!uri) throw new Error('No NWC URI configured');
  return pool.acquire(uri);
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
    return await fn(lease.value);
  } catch (e) {
    if (!isSocketSuspect(e)) throw e;
    lease.discard();
    if (!opts.retry) throw e;
    const fresh = acquire();
    try {
      return await fn(fresh.value);
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
 * What this connection can actually send, and why.
 *
 * `sats` is the number every surface displays. It is the MINIMUM of the
 * wallet's balance and the connection's remaining budget, because either one
 * running out fails the payment — a boost cannot spend a budget the wallet
 * can't fund, and it cannot spend a balance the budget won't release.
 */
export interface NwcSpendable {
  sats: number;
  /** True when the BUDGET is the binding limit, not the wallet's balance. */
  budgetLimited: boolean;
  /** The wallet's own balance in sats. */
  balanceSats: number;
  /** Absent when this connection carries no budget (an unlimited grant). */
  budget: NwcBudget | null;
}

/**
 * Whether this URI's wallet answers `get_budget`, remembered in memory so a
 * refusal costs one request per session rather than one per refresh (the
 * balance hook refreshes on every `payment_sent` push). Keyed by URI so a
 * wallet switch re-asks. Deliberately NOT persisted: `get_budget` post-dates
 * most wallets, so a `false` written today would outlive the wallet's next
 * update and permanently hide a budget that had started being reported.
 */
let budgetUnsupportedFor: string | null = null;

/**
 * Fetch this connection's spending budget, or null when it has none.
 *
 * **A null here means "no budget applies," so callers fall back to the raw
 * balance — which makes every failure direction have to resolve to null
 * safely.** It does: an unsupported method, an ungranted permission, a dead
 * relay and a malformed answer all mean we cannot show a smaller number than
 * the balance, which is the same thing this app displayed before budgets were
 * read at all. The opposite default would be worse than wrong: a budget
 * misread as 0 renders the wallet as empty and paints the boost modal's
 * insufficient-funds warning over a wallet that can pay.
 *
 * `parseNwcBudget` (lib/util.ts) holds the reading of the wire, including
 * which inputs collapse to null, and is pinned by `npm run check:nwcbudget`.
 */
export async function nwcGetBudget(): Promise<NwcBudget | null> {
  const uri = loadNwcUri();
  if (!uri) return null;
  if (budgetUnsupportedFor === uri) return null;
  // When the method list is known and lacks `get_budget`, skip the round trip
  // entirely. A null list means "we don't know" (see nwcGetMethods) — ask, and
  // let the answer settle it.
  //
  // Trusting the list matters for more than tidiness: `nwcGetSpendable` awaits
  // both reads, so a wallet that neither implements this NOR answers it would
  // hold the balance behind the SDK's 10 s read cap on every refresh. NIP-47
  // has wallets advertise their methods in `get_info`, so a wallet that
  // supports budgets and omits it from that list is out of spec — and the cost
  // of believing it is one stale-looking chip, against a blank one for
  // everybody whose wallet ignores the method.
  const methods = nwcGetMethods();
  if (methods !== null && !methods.includes('get_budget')) {
    budgetUnsupportedFor = uri;
    return null;
  }
  try {
    // A read, so a retry is safe — see `withNwcClient`.
    const res = await withNwcClient((c) => c.getBudget(), { retry: true });
    return parseNwcBudget(res);
  } catch (e) {
    // NOT_IMPLEMENTED / UNAUTHORIZED / RESTRICTED are the wallet saying it
    // will never answer this on this connection — stop asking for the session.
    // Anything else (a timeout, a dead relay) may well answer next time.
    const mapped = mapNwcError(e);
    if (mapped instanceof NwcNotAttemptedError) budgetUnsupportedFor = uri;
    return null;
  }
}

/**
 * What this connection can send, in whole sats — the number every balance
 * surface shows. Returns null when the wallet's balance is unreadable, so
 * callers hide the chip rather than paint a stale or zero value.
 *
 * **`get_balance` alone is the wrong number on a node-backed wallet.** A
 * connection to your own node (Alby Hub, an LND bridge) answers it with the
 * NODE's whole balance, while the grant this app holds may be a few thousand
 * sats a month — so the chip advertised nine million spendable sats over a
 * budget that would refuse the next boost. The two reads ride the one shared
 * socket the lease already holds, so asking for both costs no extra dial.
 */
export async function nwcGetSpendable(): Promise<NwcSpendable | null> {
  const [balanceSats, budget] = await Promise.all([
    nwcGetBalance(),
    nwcGetBudget().catch(() => null),
  ]);
  if (balanceSats === null) return null;
  const { sats, budgetLimited } = spendableSats(balanceSats, budget);
  return { sats, budgetLimited, balanceSats, budget };
}

/**
 * Fetch the wallet's current balance in sats. NIP-47 returns msats; we floor
 * to whole sats. Returns null on any error (network failure, capability not
 * granted on this connection, wallet down) — callers should hide the chip
 * rather than show a stale or zero value.
 *
 * **This is the WALLET's balance, not what this connection may spend.** A
 * display surface wants `nwcGetSpendable()`; this stays exported for the
 * places that genuinely mean the wallet total.
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
  let lease: Lease<nwc.NWCClient> | null = null;
  try {
    lease = acquire();
    const held = lease;
    const unsub = await held.value.subscribeNotifications(onNotification, [
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
    // The permission refusals become a typed NwcNotAttemptedError: the wallet
    // returned them *instead of* paying, which is the only class of keysend
    // failure boost.ts is allowed to retry over LNURL. Everything else stays
    // opaque precisely because it may have paid already — PAYMENT_FAILED
    // included, however final it reads.
    throw mapNwcError(e);
  }
}

// The two things a URI change needs from THIS half, handed to the state half
// now that it is loaded: drop the shared client (and the per-wallet budget
// verdict), and prefetch the wallet's capabilities. See nwc-state.ts.
registerNwcClientHooks({
  reset() {
    budgetUnsupportedFor = null;
    disposeNwcClient();
  },
  prefetchCapabilities() {
    void nwcFetchCapabilities().catch(() => {});
  },
});
