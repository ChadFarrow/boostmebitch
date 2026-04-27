// Lightning Address resolution. Returns a BOLT11 invoice for amount_msat.
// Boostagrams are sent in the LUD-21 `comment` field when supported.

interface LnurlPayParams {
  callback: string;
  minSendable: number;
  maxSendable: number;
  commentAllowed?: number;
  metadata?: string;
}

async function resolveLnAddress(addr: string): Promise<LnurlPayParams> {
  const [name, domain] = addr.split('@');
  if (!name || !domain) throw new Error(`Invalid lightning address: ${addr}`);
  const res = await fetch(`https://${domain}/.well-known/lnurlp/${name}`);
  if (!res.ok) throw new Error(`LNURL lookup failed for ${addr}`);
  const data = await res.json();
  if (data.tag !== 'payRequest') throw new Error('Not a payRequest endpoint');
  return data;
}

export async function fetchLnInvoice(args: {
  address: string;          // name@domain
  amount_msat: number;
  comment?: string;
}): Promise<string> {
  const params = await resolveLnAddress(args.address);
  if (
    args.amount_msat < params.minSendable ||
    args.amount_msat > params.maxSendable
  ) {
    throw new Error(
      `Amount out of range (${params.minSendable}-${params.maxSendable} msat)`,
    );
  }
  const url = new URL(params.callback);
  url.searchParams.set('amount', String(args.amount_msat));
  if (args.comment && (params.commentAllowed ?? 0) > 0) {
    url.searchParams.set(
      'comment',
      args.comment.slice(0, params.commentAllowed),
    );
  }
  const cb = await fetch(url.toString());
  if (!cb.ok) throw new Error(`LNURL callback failed: ${cb.status}`);
  const data = await cb.json();
  if (!data.pr) throw new Error('No invoice returned from LNURL callback');
  return data.pr;
}
