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
import type { Boostagram, ValueRecipient } from '../types';
import { buildLnurlComment, lnurlCallbackRefused, lnurlCommentRetry, lnurlErrorReason } from '../util';
import { sparkPayInvoice } from './spark';
import { weblnPayInvoice } from './webln';
import { pickRail, type Rail } from './boost';
import { storeBoostMetadata } from './boostbox';
import { bolt11AmountMsat } from './bolt11';
import { lnurlFetch } from './lnurl-fetch';
import { zapRequestTags, type Nip73Refs } from '@/lib/nostr/zap-request';
import { NwcIndeterminateError } from './nwc-errors';
import { activeNostr } from '@/lib/nostr/signer';
import type { PendingZapReceipt } from '@/lib/nostr/zap-receipt-wait';

/**
 * A provider's LUD-06 payRequest document, plus the two NIP-57 fields.
 *
 * Exported because this is the only place in the repo that types `allowsNostr` /
 * `nostrPubkey`, and the boost modal now reads the document once and hands it
 * back in rather than letting every zap leg fetch it twice.
 */
export interface LnurlPayMetadata {
  callback: string;
  minSendable: number;
  maxSendable: number;
  commentAllowed?: number;
  metadata?: string;
  allowsNostr?: boolean;
  nostrPubkey?: string;
}

/**
 * Nothing was paid, so the caller may still pay this leg another way.
 *
 * The distinction is the same one `NwcNotAttemptedError` draws on the boost
 * rails and it is load-bearing for the same reason: `payOne` falls back to an
 * ordinary LNURL leg on this error and ONLY on this error. Widening it to cover
 * a wallet failure would re-pay a leg that already went out.
 */
export class ZapNotAttemptedError extends Error {
  /**
   * The BoostBox record `prepareZap` had already filed when it failed, if any.
   * The POST has to precede the invoice request — the descriptor rides in the
   * LUD-21 comment — so a zap that fails AFTER it and falls back to `payLnurl`
   * would otherwise file a second record for the same leg: the recipient's
   * BoostBox then shows two entries for one payment, the first pointing at a
   * payment that never happened. Carried out so the fallback reuses it.
   */
  readonly stored: StoredBoostMetadata | null;
  constructor(message: string, stored: StoredBoostMetadata | null = null) {
    super(message);
    this.name = 'ZapNotAttemptedError';
    this.stored = stored;
  }
}

/** What BoostBox hands back for one leg: the descriptor and its landing URL. */
export type StoredBoostMetadata = NonNullable<Awaited<ReturnType<typeof storeBoostMetadata>>>;

/** What `sendZap` hands back: the payment, and how to find its receipt. */
export interface SendZapResult {
  preimage: string;
  /**
   * The BoostBox landing page for this leg, when BoostBox accepted the metadata.
   * Carried out so a zap leg's `<BoostCard>` row keeps the 📦 link an ordinary
   * LNURL leg has — the POST happens either way, and dropping the URL would
   * orphan a record that exists.
   */
  boostboxUrl?: string;
  /**
   * Everything needed to recognise this zap's kind:9735 once the provider
   * publishes it. The receipt does not exist yet — see
   * lib/nostr/zap-receipt-wait.ts.
   */
  pending: PendingZapReceipt;
}

interface PreparedZap {
  invoice: string;
  rail: Rail;
  pending: PendingZapReceipt;
  boostboxUrl?: string;
}

/**
 * What `prepareZap` has done so far, readable by `sendZap` after a throw. The
 * BoostBox record is the one side effect that precedes the invoice, and a
 * caller that falls back needs it to avoid filing another.
 */
interface PrepareContext {
  stored?: StoredBoostMetadata | null;
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
  // Through `lnurlFetch`, never a bare fetch — the same reason `lnaddr.ts` does.
  // A provider that sends no CORS header on this document is unreadable from
  // the page, and a zap needs this document before it can ask for an invoice.
  const r = await lnurlFetch(url);
  if (!r.ok) throw new Error(`LNURL lookup failed (${r.status})`);
  let data: LnurlPayMetadata & { tag?: string };
  try {
    data = JSON.parse(r.text);
  } catch {
    throw new Error('LNURL lookup did not return JSON');
  }
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
  /** Optional NIP-33 address being zapped, e.g. a live stream
   *  `30311:<pubkey>:<dTag>` — makes the receipt show up in that stream's boost
   *  feed (Fountain / tunestr / zap.stream). */
  aTag?: string;
  /** Relays where the zap receipt should be published; the recipient's LN
   *  service publishes the receipt, so include relays the recipient is likely
   *  to read from. */
  relays: string[];
  /** Rail the user picked in the modal. Falls back to pickRail() priority when
   *  omitted — without threading it, a WebLN-override user got zapped over NWC. */
  rail?: Rail;
  /**
   * Boost context, so the LUD-21 comment can carry the `rss::payment`
   * descriptor the way an ordinary LNURL leg does.
   *
   * Optional because a plain profile/note zap has no boost behind it. Omit it
   * and the comment is just the typed message, which is the old behaviour.
   *
   * The BoostBox POST happens HERE rather than at the call site: `boostbox.ts`
   * is not part of the surface components are meant to reach (see the swap-out
   * boundary in CLAUDE.md), and putting it in the modal would have meant a
   * second copy of the desc-plus-message rule living in the UI.
   */
  metadata?: { boostagram: Boostagram; recipient: ValueRecipient; legMsat: number };
  /**
   * The provider's payRequest document, when the caller already fetched it.
   *
   * The boost modal reads it while the user is still picking an amount, to
   * decide whether this leg can be a zap at all — without threading it back in,
   * every zap leg pays for the SAME document twice, once to decide and once
   * here, on the money path.
   */
  meta?: LnurlPayMetadata;
  /**
   * Which show and item this zap is for. Written onto the kind:9734 as NIP-73
   * `k`/`i` pairs, which the recipient's server mirrors onto the receipt — the
   * only place a receipt says what it paid for. See lib/nostr/zap-request.ts.
   */
  refs?: Nip73Refs;
}): Promise<SendZapResult> {
  let prepared: PreparedZap;
  const ctx: PrepareContext = {};
  try {
    prepared = await prepareZap(args, ctx);
  } catch (e) {
    // TOTAL by construction, and that is the point. Everything prepareZap does
    // happens before any invoice is paid, so every failure it can raise proves
    // nothing moved — which is what licenses the caller to fall back to an
    // ordinary LNURL leg. Classifying throw sites one at a time is how the
    // opposite mistake gets made: one unwrapped `throw` reads as a payment
    // failure and the leg is dropped instead of paid. Same discipline as
    // NwcNotAttemptedError; see boost invariant 11 in CLAUDE.md.
    throw e instanceof ZapNotAttemptedError
      ? e
      : new ZapNotAttemptedError(e instanceof Error ? e.message : String(e), ctx.stored ?? null);
  }

  let preimage: string;
  try {
    // Loaded here, not at module top: `sendZap` is reached from the boost modal,
    // which is in every route's first load. See lib/v4v/nwc-state.ts.
    if (prepared.rail === 'nwc') preimage = await (await import('./nwc')).nwcPayInvoice(prepared.invoice);
    else if (prepared.rail === 'spark') preimage = await sparkPayInvoice(prepared.invoice);
    else preimage = await weblnPayInvoice(prepared.invoice);
  } catch (e) {
    // NOT a ZapNotAttemptedError. The invoice was handed to a wallet, so this
    // leg is finished either way and must never be re-paid over LNURL.
    //
    // The wrapper must PRESERVE indeterminacy. `nwcPayInvoice` already mapped
    // a reply timeout to `NwcIndeterminateError` — the request was published
    // and the wallet may have paid — and `payOne`'s outer catch reads that
    // class to render `?` instead of ✗. A plain Error here stripped it, so a
    // zap leg on a wallet that never answered showed ✗, and a ✗ is what talks
    // the user into boosting again and paying twice. Same rule, same shape, as
    // the keysend→LNURL wrapper in boost.ts.
    //
    // The wording claims nothing about WHY. It said "wallet rejected the zap
    // invoice", which is false for the commonest cause: the wallet's relay
    // could not be reached at all ("Failed to connect to wss://…"), so no
    // wallet saw the invoice. `msg` carries the actual reason.
    const msg = e instanceof Error ? e.message : String(e);
    const wrapped = `zap via ${prepared.rail} wallet did not complete: ${msg}`;
    throw e instanceof NwcIndeterminateError
      ? new NwcIndeterminateError(wrapped)
      : new Error(wrapped);
  }
  return { preimage, pending: prepared.pending, boostboxUrl: prepared.boostboxUrl };
}

/**
 * Everything up to and including the invoice, none of which spends anything.
 *
 * Split out of `sendZap` so the boundary between "nothing moved" and "the wallet
 * has the invoice" is a scope rather than a convention.
 */
async function prepareZap(
  args: Parameters<typeof sendZap>[0],
  ctx: PrepareContext,
): Promise<PreparedZap> {
  const nostr = activeNostr();
  if (!nostr) {
    throw new Error('No Nostr signer available');
  }
  const rail = args.rail ?? pickRail();
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

  const meta = args.meta ?? (await fetchPayMetadata(lnurlSourceUrl));
  if (!meta.allowsNostr || !meta.nostrPubkey) {
    throw new Error("Recipient's Lightning provider does not support Nostr zaps");
  }
  // Kept, not just tested. This is the key NIP-57 Appendix F makes a client
  // check the receipt's author against, so discarding it (which this function
  // did for the life of the live-stream zap path) leaves nothing to tell a real
  // receipt from one anybody published. See lib/nostr/zap-receipt-match.ts.
  const zapperPubkey = meta.nostrPubkey;

  const amountMsat = args.amountSats * 1000;
  if (amountMsat < meta.minSendable || amountMsat > meta.maxSendable) {
    throw new Error(
      `Amount out of range (${meta.minSendable}-${meta.maxSendable} msat)`,
    );
  }

  const lnurl = lnurlBech32(lnurlSourceUrl);
  const receiptRelays = args.relays.slice(0, 8);

  // The tag list is a pinned pure function, because the recipient's server
  // mirrors it onto the receipt the note quotes — see lib/nostr/zap-request.ts
  // for the two real Fountain requests it is checked against. It carries the
  // NIP-73 `k`/`i` pairs naming the show and item; without them the receipt
  // parses as no show and no episode, in our own explorer included.
  //
  // No `client` tag. The recipient's LNURL server reads this event before any
  // relay does, so an app-identity claim here is a money-path change; that rule
  // is about THAT tag, and reading it as "no tags at all" is what stripped the
  // podcast linkage off every receipt this app produced.
  //
  // `p` is the payee's own pubkey when NIP-05 named one, else the provider's
  // `nostrPubkey` — which is the key that signs the receipt, and exactly what
  // Fountain writes for every zap it sends. Alby's callback issued an invoice
  // for both shapes when asked (2026-09-16).
  const tags = zapRequestTags({
    relays: receiptRelays,
    amountMsat,
    lnurl,
    recipientPubkey: args.recipientPubkey,
    eventId: args.eventId,
    aTag: args.aTag,
    refs: args.refs,
  });

  // The zap request's content is what Nostr clients RENDER as the zap message,
  // so it stays the human's prose. The descriptor belongs in the LUD-21
  // `comment` below, which is the machine-readable channel the recipient's LN
  // service reads — putting it here would print `rss::payment::boost <url>` in
  // the middle of every zap in every client.
  const template: EventTemplate = {
    kind: 9734,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: args.comment ?? '',
  };
  const signed = await nostr.signEvent(template);

  // Same channel and same rule as an ordinary LNURL leg (`payLnurl`): the
  // descriptor is worth something only whole, the message reads fine clipped,
  // so `buildLnurlComment` fits the descriptor first and spends the remainder
  // on prose — never the reverse, which cuts a URL into a dead link and still
  // burns the whole allowance on it.
  //
  // Without this a live-stream boost to a Fountain host arrived with the typed
  // message alone and no machine-readable metadata at all, which is the exact
  // gap the @fountain.fm keysend divert exists to close — it just never covered
  // this path, because zaps don't go through `payLnurl`.
  const stored = args.metadata
    ? await storeBoostMetadata({
        boostagram: args.metadata.boostagram,
        recipient: args.metadata.recipient,
        splitWeight: args.metadata.recipient.split,
        legMsat: args.metadata.legMsat,
      })
    : null;
  // Visible to sendZap's catch from here on: a failure past this line has
  // filed a record, and the LNURL fallback must reuse it rather than file
  // another. See ZapNotAttemptedError.stored.
  ctx.stored = stored;

  const commentArgs = { desc: stored?.desc, message: args.comment };
  const comment = buildLnurlComment(commentArgs, meta.commentAllowed);

  // LUD-06 error shape is { status: 'ERROR', reason }; some non-compliant
  // services use `message`, `error`, or just return a plain-text body, and a
  // refusal arrives as a 200 as often as a 4xx. `lnurlErrorReason` tries them
  // all so the user sees the actual reason instead of "no invoice".
  const ask = async (c: string | undefined) => {
    const u = new URL(meta.callback);
    u.searchParams.set('amount', String(amountMsat));
    u.searchParams.set('nostr', JSON.stringify(signed));
    u.searchParams.set('lnurl', lnurl);
    if (c) u.searchParams.set('comment', c);
    const res = await lnurlFetch(u.toString());
    let data: Record<string, unknown> | null = null;
    try { data = JSON.parse(res.text); } catch { /* non-JSON body */ }
    const why = lnurlErrorReason(res.text);
    return { res, data, why, failed: lnurlCallbackRefused(res.status, res.text) };
  };

  let out = await ask(comment);
  // Same refusal and same answer as `fetchLnInvoice` — see the long note
  // there. A service that under-enforces its advertised `commentAllowed`
  // otherwise kills the leg with the sats still in the wallet, and nothing
  // moved before the refusal, so asking again for an invoice is safe.
  //
  // ON THIS PATH THE PROSE IS ALREADY SAFE, which is what makes the retry
  // clearly worth taking: a zap carries the typed message in the kind:9734
  // `content` as well, and that is the copy every Nostr client renders. What
  // the comment alone carries is the descriptor — the URL pointing at the
  // BoostBox record — so dropping the comment orphans that record while
  // dropping the prose inside it costs the reader nothing.
  if (out.failed && comment) {
    const retry = lnurlCommentRetry(commentArgs, out.why, comment);
    if (retry) {
      if (retry.comment === undefined) {
        // Nothing shorter fits, so the choice is a zap with no descriptor or no
        // zap at all. Take the zap — but never silently: the kind:9735 receipt
        // still reaches the stream and the prose still rides in the kind:9734
        // `content`, and what is lost is the one thing nobody can see is
        // missing. Measured against a service enforcing 90 characters on a
        // 91-character descriptor.
        console.warn(
          `[zap] comment of ${comment.length} refused for length and nothing shorter fits ` +
            `(${out.why ?? 'no reason given'}) — paying with NO comment. The recipient gets ` +
            `no rss::payment descriptor for this zap; the typed message still rides in the ` +
            `kind:9734 content.`,
        );
      } else {
        console.info(
          `[zap] comment of ${comment.length} refused; retrying at ${retry.comment.length} (${
            retry.comment.startsWith('rss::payment') ? 'descriptor kept' : 'no descriptor'
          })`,
        );
      }
      out = await ask(retry.comment);
    }
  }
  if (out.failed) {
    throw new Error(
      out.why ? `LNURL service: ${out.why}` : `LNURL callback failed (${out.res.status})`,
    );
  }
  const invoice = out.data?.pr;
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

  return {
    invoice,
    rail,
    boostboxUrl: stored?.url || undefined,
    pending: {
      zapperPubkey,
      recipientPubkey: args.recipientPubkey,
      requestId: signed.id,
      bolt11: invoice,
      amountMsat,
      relays: receiptRelays,
    },
  };
}
