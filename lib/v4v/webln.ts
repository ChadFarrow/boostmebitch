// WebLN payments — uses window.webln from Alby/Mutiny browser extensions.

type Webln = NonNullable<Window['webln']>;

export function hasWebln(): boolean {
  return typeof window !== 'undefined' && !!window.webln;
}

// Returns the resolved provider so callers don't need to assert again.
async function ensureWebln(): Promise<Webln> {
  const wl = typeof window !== 'undefined' ? window.webln : undefined;
  if (!wl) throw new Error('WebLN provider not found');
  await wl.enable();
  return wl;
}

export async function weblnPayInvoice(invoice: string): Promise<string> {
  const wl = await ensureWebln();
  const r = await wl.sendPayment(invoice);
  return r.preimage;
}

export async function weblnKeysend(args: {
  pubkey: string;
  amount_sat: number;
  customRecords?: Record<string, string>;
}): Promise<string> {
  const wl = await ensureWebln();
  if (!wl.keysend) throw new Error('Wallet does not support keysend');
  const r = await wl.keysend({
    destination: args.pubkey,
    amount: args.amount_sat,
    customRecords: args.customRecords,
  });
  return r.preimage;
}
