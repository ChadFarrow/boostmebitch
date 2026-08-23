// Lightning Address resolution. Returns a BOLT11 invoice for amount_msat.
// Boost metadata rides in the LUD-21 `comment` field when supported — see
// buildLnurlComment for why the descriptor and the message are passed
// separately rather than pre-joined by the caller.

import { bolt11AmountMsat } from './bolt11';
import { lnurlFetch } from './lnurl-fetch';
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
  // Never a bare fetch. Not every provider sends CORS headers on this document
  // — livewire.io 302s to a host that does not — and a blocked read here fails
  // the leg on EVERY rail, since LNURL is the one rail all of them support.
  // See lnurl-fetch.ts.
  const res = await lnurlFetch(`https://${domain}/.well-known/lnurlp/${name}`);
  if (!res.ok) throw new Error(`LNURL lookup failed for ${addr}`);
  let data: LnurlPayParams & { tag?: string };
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new Error(`LNURL lookup for ${addr} did not return JSON`);
  }
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
  // An LNURL leg carries NO TLV boostagram — no sender_id, no podcast/episode,
  // no remote_feed_guid — so this one comment is the entire metadata channel,
  // and until now nothing on the path logged at all. "I don't see any payment
  // metadata being sent" was unanswerable from a console, whether it worked or
  // not.
  //
  // The descriptor is printed in full: it is a public URL, it is already
  // rendered by <BoostCard>, and it is the thing that proves metadata went out.
  // The message is counted, never printed — it is the user's own prose, and a
  // console line is something people paste into a chat.
  console.info(
    `[lnurl] ${args.address} → ${
      comment
        ? `comment (${
            args.desc ? `desc "${args.desc}"` : 'NO DESCRIPTOR'
          }, message ${args.message?.trim().length ?? 0} chars, ${comment.length}/${
            params.commentAllowed ?? 0
          } used)`
        : `NO COMMENT (recipient allows ${params.commentAllowed ?? 0})`
    }`,
  );
  const cb = await lnurlFetch(url.toString());
  if (!cb.ok) throw new Error(`LNURL callback failed: ${cb.status}`);
  let data: { pr?: string };
  try {
    data = JSON.parse(cb.text);
  } catch {
    throw new Error('LNURL callback did not return JSON');
  }
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
