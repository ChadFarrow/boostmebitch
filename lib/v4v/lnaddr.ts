// Lightning Address resolution. Returns a BOLT11 invoice for amount_msat.
// Boost metadata rides in the LUD-21 `comment` field when supported — see
// buildLnurlComment for why the descriptor and the message are passed
// separately rather than pre-joined by the caller.

import { bolt11AmountMsat } from './bolt11';
import { buildLnurlComment } from '@/lib/util';

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
  /** BoostBox's `rss::payment::…` descriptor. Sent whole or not at all. */
  desc?: string;
  /** The user's typed message. Clipped to whatever budget remains. */
  message?: string;
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
  const comment = buildLnurlComment(args, params.commentAllowed);
  if (comment) url.searchParams.set('comment', comment);
  const cb = await fetch(url.toString());
  if (!cb.ok) throw new Error(`LNURL callback failed: ${cb.status}`);
  const data = await cb.json();
  if (!data.pr) throw new Error('No invoice returned from LNURL callback');
  // We always request a concrete amount; an amountless invoice (null) would
  // let the server pick — reject it along with any mismatch.
  const invoiceMsat = bolt11AmountMsat(data.pr);
  if (invoiceMsat === null) {
    throw new Error(`LNURL server for ${args.address} returned an amountless invoice`);
  }
  if (invoiceMsat !== args.amount_msat) {
    throw new Error(
      `LNURL invoice amount mismatch for ${args.address}: requested ${args.amount_msat} msat, invoice is for ${invoiceMsat} msat`,
    );
  }
  return data.pr;
}
