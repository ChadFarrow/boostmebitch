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

// Re-export the URI accessors so existing call sites keep their imports.
export const saveNwcUri = (uri: string) => { storage.nwcUri.set(uri); notify(); };
export const loadNwcUri = () => storage.nwcUri.get();
export const clearNwcUri = () => { storage.nwcUri.clear(); notify(); };
export const hasNwc = () => storage.nwcUri.has();

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
      await withTimeout(c.getInfo());
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
  const res = await c.payInvoice({ invoice });
  return res.preimage;
}

/**
 * Fetch the wallet's current balance in sats. NIP-47 returns msats; we floor
 * to whole sats. Returns null on any error (network failure, capability not
 * granted on this connection, wallet down) — callers should hide the chip
 * rather than show a stale or zero value.
 */
export async function nwcGetBalance(): Promise<number | null> {
  try {
    const c = client();
    const res = await c.getBalance();
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
  try {
    const c = client();
    return await c.subscribeNotifications(onNotification, [
      'payment_received',
      'payment_sent',
    ]);
  } catch {
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
  const res = await c.payKeysend({
    pubkey: args.pubkey,
    amount: args.amount_msat,
    preimage,
    tlv_records: args.tlv_records ?? [],
  });
  return res.preimage ?? preimage;
}
