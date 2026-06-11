// NIP-57 zap flow.
//
//   1. Fetch recipient profile, read lud16 (or decode lud06 → LNURL).
//   2. GET the LNURL-pay metadata, confirm allowsNostr / nostrPubkey.
//   3. Build + sign a kind:9734 zap request via the user's NIP-07 signer.
//   4. GET <callback>?amount=<msat>&nostr=<encoded>&lnurl=<lnurl> → BOLT11.
//   5. Pay the invoice via NWC, Spark, or WebLN (same rails as boost).
//
// We deliberately reuse the boost rails for step 5; the only Lightning bit
// here that the boost orchestrator doesn't already do is the LNURL ↔ zap
// request handshake.

import { bech32 } from '@scure/base';
import type { EventTemplate } from 'nostr-tools';
import { nwcPayInvoice } from './nwc';
import { sparkPayInvoice } from './spark';
import { weblnPayInvoice } from './webln';
import { pickRail } from './boost';
import { bolt11AmountMsat } from './bolt11';

interface LnurlPayMetadata {
  callback: string;
  minSendable: number;
  maxSendable: number;
  commentAllowed?: number;
  metadata?: string;
  allowsNostr?: boolean;
  nostrPubkey?: string;
}

function lud06ToUrl(lud06: string): string {
  const { bytes } = bech32.decodeToBytes(lud06.toLowerCase());
  return new TextDecoder().decode(bytes);
}

function lnAddressToUrl(addr: string): string {
  const [name, domain] = addr.split('@');
  if (!name || !domain) throw new Error(`Invalid lightning address: ${addr}`);
  return `https://${domain}/.well-known/lnurlp/${name}`;
}

async function fetchPayMetadata(url: string): Promise<LnurlPayMetadata> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`LNURL lookup failed (${r.status})`);
  const data = await r.json();
  if (data.tag !== 'payRequest') throw new Error('Not a payRequest endpoint');
  return data;
}

function lnurlBech32(rawUrl: string): string {
  return bech32.encodeFromBytes('lnurl', new TextEncoder().encode(rawUrl));
}

export async function sendZap(args: {
  recipientPubkey: string;
  recipientLud16?: string;
  recipientLud06?: string;
  amountSats: number;
  comment?: string;
  /** Optional event id being zapped (omit for pubkey-only "profile zap"). */
  eventId?: string;
  /** Relays where the zap receipt should be published; the recipient's LN
   *  service publishes the receipt, so include relays the recipient is likely
   *  to read from. */
  relays: string[];
}): Promise<{ preimage: string }> {
  if (typeof window === 'undefined' || !window.nostr) {
    throw new Error('No Nostr signer available');
  }
  const rail = pickRail();
  if (!rail) {
    throw new Error('No payment provider available (connect NWC, Spark, or WebLN)');
  }

  const lnurlSourceUrl = args.recipientLud16
    ? lnAddressToUrl(args.recipientLud16)
    : args.recipientLud06
      ? lud06ToUrl(args.recipientLud06)
      : null;
  if (!lnurlSourceUrl) {
    throw new Error('Recipient has no Lightning address (lud16/lud06) on their Nostr profile');
  }

  const meta = await fetchPayMetadata(lnurlSourceUrl);
  if (!meta.allowsNostr || !meta.nostrPubkey) {
    throw new Error("Recipient's Lightning provider does not support Nostr zaps");
  }

  const amountMsat = args.amountSats * 1000;
  if (amountMsat < meta.minSendable || amountMsat > meta.maxSendable) {
    throw new Error(
      `Amount out of range (${meta.minSendable}-${meta.maxSendable} msat)`,
    );
  }

  const lnurl = lnurlBech32(lnurlSourceUrl);

  const tags: string[][] = [
    ['relays', ...args.relays.slice(0, 8)],
    ['amount', String(amountMsat)],
    ['lnurl', lnurl],
    ['p', args.recipientPubkey],
  ];
  if (args.eventId) tags.push(['e', args.eventId]);

  const template: EventTemplate = {
    kind: 9734,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: args.comment ?? '',
  };
  const signed = await window.nostr.signEvent(template);

  const cbUrl = new URL(meta.callback);
  cbUrl.searchParams.set('amount', String(amountMsat));
  cbUrl.searchParams.set('nostr', JSON.stringify(signed));
  cbUrl.searchParams.set('lnurl', lnurl);
  if (args.comment && (meta.commentAllowed ?? 0) > 0) {
    cbUrl.searchParams.set('comment', args.comment.slice(0, meta.commentAllowed));
  }

  const cb = await fetch(cbUrl.toString());
  const cbText = await cb.text();
  let cbData: Record<string, unknown> | null = null;
  try { cbData = JSON.parse(cbText); } catch { /* non-JSON body */ }
  // LUD-06 error shape is { status: 'ERROR', reason }; some non-compliant
  // services use `message`, `error`, or just return a plain-text body. Try
  // them all so the user sees the actual reason instead of "no invoice".
  const reason =
    (cbData?.reason as string | undefined) ??
    (cbData?.message as string | undefined) ??
    (cbData?.error as string | undefined) ??
    (!cbData && cbText.trim() ? cbText.trim().slice(0, 200) : undefined);
  if (!cb.ok) {
    throw new Error(reason ? `LNURL service: ${reason}` : `LNURL callback failed (${cb.status})`);
  }
  if (cbData?.status === 'ERROR' || (reason && !cbData?.pr)) {
    throw new Error(`LNURL service: ${reason ?? 'unknown error'}`);
  }
  const invoice = cbData?.pr;
  if (typeof invoice !== 'string' || !invoice) {
    throw new Error('LNURL callback returned no invoice');
  }
  // We always request a concrete amount; an amountless invoice (null) would
  // let the server pick — reject it along with any mismatch.
  const invoiceMsat = bolt11AmountMsat(invoice);
  if (invoiceMsat === null || invoiceMsat !== amountMsat) {
    throw new Error(
      `Zap invoice amount mismatch: requested ${amountMsat} msat, invoice is for ${invoiceMsat ?? 'no amount'}`,
    );
  }

  let preimage: string;
  try {
    if (rail === 'nwc') preimage = await nwcPayInvoice(invoice);
    else if (rail === 'spark') preimage = await sparkPayInvoice(invoice);
    else preimage = await weblnPayInvoice(invoice);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${rail} wallet rejected the zap invoice: ${msg}`);
  }
  return { preimage };
}
