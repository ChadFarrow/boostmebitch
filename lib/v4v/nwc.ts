// NWC / NIP-47 payments using @getalby/sdk.
// When v4v-toolkit ships its own NWC client, swap this file's imports.

import { nwc } from '@getalby/sdk';

const STORAGE_KEY = 'bmb:nwc_uri';

export function saveNwcUri(uri: string) {
  localStorage.setItem(STORAGE_KEY, uri);
}
export function loadNwcUri(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(STORAGE_KEY);
}
export function clearNwcUri() {
  localStorage.removeItem(STORAGE_KEY);
}

export function hasNwc(): boolean {
  return !!loadNwcUri();
}

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
