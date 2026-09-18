import { NextResponse } from 'next/server';
import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools';
import { withErrorHandling, readCappedRequestJson, requireJsonBody, NO_STORE } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { siteSecretKey, sitePubkey } from '@/lib/nostr/site-key';
import { summaryReceiptTemplate, summaryRequestTemplateFromSpec, validateSummaryRequest } from '@/lib/nostr/zap-request';

// The second signing oracle for the SITE's Nostr identity, beside site-sign.
//
// It signs ONE shape: a kind:9735 "summary receipt" for the sats a boost paid,
// derived here from a kind:9734. Two ways in, one set of rules:
//
//   { request }  the SENDER signed the 9734 — a note the user's key publishes.
//   { spec }     the note is site-published (signed out, or Anonymous), so the
//                site authors the 9734 too, from three bounded facts: amount,
//                relays, refs. The receipt's sender is then the site, as the
//                note's author is; a user-signed request would name the user.
//
// The client never hands over receipt tags. That is what bounds this oracle:
// a caller can make the site attest a payment from their OWN key, or an
// anonymous one from the site's — the same claims a boost note already lets
// them make — and nothing else: not a payment from someone else's key, not a
// quote of any note, not a line of prose. Both ways pass the same
// `validateSummaryRequest` before anything is signed as a receipt. The
// reasoning, and why the receipt carries no bolt11, is in
// lib/nostr/zap-request.ts and docs/money-boosts.md.
//
// Same protections as site-sign, in the same order: per-IP and per-route rate
// limit, JSON content type, 503 when the key is unset, a capped body read,
// then validation, then the signature check.

const MAX_REQUEST_BYTES = 16 * 1024;

export async function POST(req: Request) {
  const limited = rateLimit(req, 'zap-receipt-sign', 30);
  if (limited) return limited;
  const notJson = requireJsonBody(req);
  if (notJson) return notJson;

  const sk = siteSecretKey();
  const site = sitePubkey();
  if (!sk || !site) {
    return NextResponse.json(
      { error: 'site Nostr identity not configured' },
      { status: 503 },
    );
  }

  return withErrorHandling(async () => {
    const read = await readCappedRequestJson(req, MAX_REQUEST_BYTES);
    if (!read.ok) return read.response;
    const body = read.body;
    const now = Math.floor(Date.now() / 1000);
    const b = body && typeof body === 'object' ? (body as { request?: unknown; spec?: unknown }) : {};
    let input: unknown = b.request;
    if (input === undefined && b.spec !== undefined) {
      // The site authors the request. Built by the leaf, signed here, and then
      // validated below exactly as a sender-signed one is — one gate.
      const template = summaryRequestTemplateFromSpec(b.spec, site, now);
      if (!template) return NextResponse.json({ error: 'bad spec' }, { status: 400 });
      input = finalizeEvent(template, sk);
    }
    const checked = validateSummaryRequest(input, site, now);
    if (!checked.ok) {
      return NextResponse.json({ error: checked.reason }, { status: 400 });
    }
    // The shape is right; now the signature. `verifyEvent` recomputes the id
    // from the seven fields and checks the sig against `pubkey`, so a request
    // whose `P` will name the sender is one that sender really signed — and a
    // site-authored one is one this process just signed.
    if (!verifyEvent(checked.request as Event)) {
      return NextResponse.json({ error: 'bad signature' }, { status: 400 });
    }
    const signed = finalizeEvent(summaryReceiptTemplate(checked.request, site, now), sk);
    return NextResponse.json(
      { event: signed },
      { headers: NO_STORE },
    );
  }, 'zap-receipt-sign failed');
}
