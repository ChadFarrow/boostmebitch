// NWC / NIP-47 payments using @getalby/sdk.
// When v4v-toolkit ships its own NWC client, swap this file's imports.

import { nwc } from '@getalby/sdk';
import { storage } from '../storage';

// Components reading hasNwc() during render need to refresh when an outside
// actor flips the connect state — most commonly the wallet modal showing the
// connect form alongside another component reading the same flag. The Spark
// rail uses the same pattern (lib/v4v/spark.ts:subscribeSpark).
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
}

export function subscribeNwc(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

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
 * Validate an NWC URI by opening a client against it and asking the wallet
 * for its info. Round-trips the connect relay so a malformed URI / dead
 * relay / wrong secret all surface here instead of silently sitting in
 * localStorage and failing on the first boost.
 *
 * Returns null on success, an error message on failure. Does not save the
 * URI — call `saveNwcUri` separately once this resolves successfully.
 */
export async function nwcValidate(uri: string): Promise<string | null> {
  let c: nwc.NWCClient;
  try {
    c = new nwc.NWCClient({ nostrWalletConnectUrl: uri });
  } catch (e) {
    return e instanceof Error ? e.message : 'invalid URI';
  }
  try {
    // 12s timeout: NIP-47 relays sometimes take a couple seconds for the
    // first round-trip; shorter and we false-negative slow wallets.
    await Promise.race([
      c.getInfo(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout — wallet did not respond in 12s')), 12000),
      ),
    ]);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'wallet did not respond';
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
  // NIP-47 pay_keysend takes amount in msat and TLVs as { type, value(hex) }
  const tlv = (args.tlv_records ?? []).map((r) => ({
    type: r.type,
    value: r.value,
  }));
  const res = await c.payKeysend({
    pubkey: args.pubkey,
    amount: args.amount_msat,
    tlv_records: tlv,
  } as any);
  return res.preimage;
}
