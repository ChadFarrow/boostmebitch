// WebLN payments — uses window.webln from Alby/Mutiny browser extensions.

export function hasWebln(): boolean {
  return typeof window !== 'undefined' && !!window.webln;
}

export async function ensureWebln() {
  if (!window.webln) throw new Error('WebLN provider not found');
  await window.webln.enable();
}

export async function weblnPayInvoice(invoice: string): Promise<string> {
  await ensureWebln();
  const r = await window.webln!.sendPayment(invoice);
  return r.preimage;
}

export async function weblnKeysend(args: {
  pubkey: string;
  amount_sat: number;
  customRecords?: Record<string, string>;
}): Promise<string> {
  await ensureWebln();
  if (!window.webln!.keysend) throw new Error('Wallet does not support keysend');
  const r = await window.webln!.keysend({
    destination: args.pubkey,
    amount: args.amount_sat,
    customRecords: args.customRecords,
  });
  return r.preimage;
}
