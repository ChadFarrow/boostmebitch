import { NextResponse } from 'next/server';
import { verifyEvent } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools';
import { withErrorHandling, readCappedRequestJson, requireJsonBody, NO_STORE, withCors, corsPreflight } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { sitePubkey } from '@/lib/nostr/site-key';
import { validateBoostTemplate } from '@/lib/site-sign-template';
import { stampMac, siteEventId } from '@/lib/site-stamp-server';
import { stampAddressConfigured, createStampInvoice } from '@/lib/stamp-address';
import { encodeStamp, stampDue, quotedReceiptFits, STAMP_TTL_SECS } from '@/lib/site-stamp';
import { BRAND } from '@/lib/brand';

// The NOTE STAMP: before `/api/nostr/site-sign` will sign a boost note under
// the site's verified name, the browser pays an invoice fetched here from the
// site's own Lightning address (SITE_STAMP_LNADDRESS), for EXACTLY that note,
// priced at 1% of the boost the note states (`stampDue`, check:sitestamp). This route validates the template with the same rules site-sign applies
// — so nobody pays for a note that would be refused — computes the event id the
// site key will give it, and answers the invoice plus a token binding that id to
// the invoice's LUD-21 verify link. site-sign signs once that link says
// settled. Reasoning: docs/security.md, "the site-sign stamp"; rules and the
// wire readers: lib/site-stamp.ts; the fetches: lib/stamp-address.ts.
//
// Unauthenticated like site-sign, so the same order: limit first, then the
// body check, then a capped read. Every request asks the address for an
// invoice — cheap, but a row on its node — so the per-IP limit matches
// site-sign's.

// site-sign's 32 KB for the template, plus the ONE receipt it may quote: the
// largest the receipt route signs is 7,425 bytes. check:sitestamp keeps the
// margin above the largest receipt, built with the real builders.
const MAX_REQUEST_BYTES = 40 * 1024;

async function handlePost(req: Request) {
  const limited = rateLimit(req, 'site-stamp', 30);
  if (limited) return limited;
  const notJson = requireJsonBody(req);
  if (notJson) return notJson;

  const site = sitePubkey();
  const mac = stampMac();
  if (!site || !mac || !stampAddressConfigured()) {
    return NextResponse.json({ error: 'note stamps are not configured' }, { status: 503 });
  }

  return withErrorHandling(async () => {
    const read = await readCappedRequestJson(req, MAX_REQUEST_BYTES);
    if (!read.ok) return read.response;
    const body = read.body;
    const raw = body && typeof body === 'object' ? (body as { template?: unknown }).template : undefined;
    let template;
    // The same `e.message` reflection as site-sign, safe for the same reason:
    // every throw inside `validateBoostTemplate` is a literal written there.
    // Read the comment at site-sign's call before adding anything to this try.
    try {
      template = validateBoostTemplate(raw, site, { checkCreatedAt: true });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'invalid template' },
        { status: 400 },
      );
    }
    // The price is read from the note: 1% of its ONE `amount` tag, and only
    // when its sentence states the same number — so a note claiming a larger
    // boost costs more to fake. Every `why` is a literal (lib/site-stamp.ts).
    const due = stampDue(template);
    if (!due.ok) return NextResponse.json({ error: due.why }, { status: 400 });
    // The receipt the note quotes is what Fountain draws the ⚡ figure from,
    // and the receipt route signs one for any amount with no payment — so it
    // may not claim more than the note this stamp is priced at. Its fields
    // first (pure), then its id and signature: only a receipt THIS key signed,
    // byte for byte, passes. `verifyEvent` hashes outside its own try and
    // throws on a malformed object, hence the catch.
    const receipt = body && typeof body === 'object' ? (body as { receipt?: unknown }).receipt : undefined;
    const fit = quotedReceiptFits(template, receipt, site);
    if (!fit.ok) return NextResponse.json({ error: fit.why }, { status: 400 });
    if (template.tags.some((tag) => tag[0] === 'q')) {
      let signed = false;
      try {
        signed = verifyEvent(receipt as Event);
      } catch {
        signed = false;
      }
      if (!signed) return NextResponse.json({ error: 'the quoted receipt is not the site’s' }, { status: 400 });
    }
    const id = siteEventId(template, site);
    let invoice: { bolt11: string; verifyUrl: string };
    try {
      // The comment is what the owner's wallet shows beside the sats.
      invoice = await createStampInvoice(`${BRAND.displayName} note stamp`, due.sats);
    } catch {
      return NextResponse.json({ error: 'could not create the stamp invoice' }, { status: 502 });
    }
    const exp = Math.floor(Date.now() / 1000) + STAMP_TTL_SECS;
    const stamp = encodeStamp({ v: 1, id, vu: invoice.verifyUrl, exp }, mac);
    return NextResponse.json({ invoice: invoice.bolt11, stamp }, { headers: NO_STORE });
  }, 'site-stamp failed');
}

// Cross-brand CORS (lib/cross-brand-cors.ts): a note signed by the OTHER
// deploy's key pays that deploy's stamp, from this site's browser.
export async function POST(req: Request) {
  return withCors(req, await handlePost(req));
}

export function OPTIONS(req: Request) {
  return corsPreflight(req);
}
