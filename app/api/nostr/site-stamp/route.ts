import { NextResponse } from 'next/server';
import { withErrorHandling, readCappedRequestJson, requireJsonBody, NO_STORE, withCors, corsPreflight } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { sitePubkey } from '@/lib/nostr/site-key';
import { validateBoostTemplate } from '@/lib/site-sign-template';
import { stampMac, siteEventId } from '@/lib/site-stamp-server';
import { lnbitsConfigured, createStampInvoice } from '@/lib/lnbits';
import { encodeStamp, STAMP_SATS, STAMP_INVOICE_EXPIRY_SECS, STAMP_TTL_SECS } from '@/lib/site-stamp';
import { BRAND } from '@/lib/brand';

// The NOTE STAMP: before `/api/nostr/site-sign` will sign a boost note under
// the site's verified name, the browser pays a 1-sat invoice minted here, on
// the site's own LNbits wallet, for EXACTLY that note. This route validates the
// template with the same rules site-sign applies — so nobody pays for a note
// that would be refused — computes the event id the site key will give it, and
// answers the invoice plus a token binding that id to the invoice's payment
// hash. site-sign signs once LNbits says the hash is paid. Reasoning:
// docs/security.md, "the site-sign stamp"; rules: lib/site-stamp.ts.
//
// Unauthenticated like site-sign, so the same order: limit first, then the
// body check, then a capped read. Every request mints an invoice in LNbits —
// cheap, but a row — so the per-IP limit matches site-sign's.

const MAX_REQUEST_BYTES = 32 * 1024;

async function handlePost(req: Request) {
  const limited = rateLimit(req, 'site-stamp', 30);
  if (limited) return limited;
  const notJson = requireJsonBody(req);
  if (notJson) return notJson;

  const site = sitePubkey();
  const mac = stampMac();
  if (!site || !mac || !lnbitsConfigured()) {
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
    const id = siteEventId(template, site);
    let invoice: { paymentHash: string; bolt11: string };
    try {
      invoice = await createStampInvoice(STAMP_SATS, `${BRAND.displayName} note stamp`, STAMP_INVOICE_EXPIRY_SECS);
    } catch {
      return NextResponse.json({ error: 'could not create the stamp invoice' }, { status: 502 });
    }
    const exp = Math.floor(Date.now() / 1000) + STAMP_TTL_SECS;
    const stamp = encodeStamp({ v: 1, id, ph: invoice.paymentHash, exp }, mac);
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
