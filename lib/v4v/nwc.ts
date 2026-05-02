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

export async function nwcPayInvoice(invoice: string): Promise<string> {
  const c = client();
  const res = await c.payInvoice({ invoice });
  return res.preimage;
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
