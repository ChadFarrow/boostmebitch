import { NextResponse } from 'next/server';
import { finalizeEvent, type EventTemplate } from 'nostr-tools/pure';
import { withErrorHandling, readCappedRequestJson, requireJsonBody, NO_STORE, withCors, corsPreflight } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { siteSecretKey, sitePubkey } from '@/lib/nostr/site-key';
import { validateBoostTemplate } from '@/lib/site-sign-template';
import { stampMac, requireStamp, siteEventId } from '@/lib/site-stamp-server';
import { stampAddressConfigured, stampInvoicePaid } from '@/lib/stamp-address';
import { splitSignBody, stampGate, STAMP_NOT_PAID, STAMP_UNCONFIRMED } from '@/lib/site-stamp';

// Server-side signer for the SITE's own Nostr identity. Lets a signed-OUT user
// still post their boost note to Nostr — signed by the app's key, not theirs.
//
// The private key (SITE_NOSTR_SK, nsec or hex) is server-only and NEVER shipped
// to the browser (a signing key in the bundle is extractable by anyone). The
// client POSTs an unsigned boost-note template here; we sign it and return the
// signed event, which the client then publishes to relays itself.
//
// THE STAMP. A note is signed only with proof that its stamp invoice —
// fetched by /api/nostr/site-stamp from the site's own Lightning address for
// EXACTLY this event — settled, by that invoice's LUD-21 verify link. The body is `{ template, stamp }`; a bare template
// (what a page from before the stamp sends) is still signed while
// SITE_SIGN_REQUIRE_STAMP is not `on` (phase 1), and refused with 402 after.
// The template rules live in lib/site-sign-template.ts, shared with the stamp
// route; the gate in lib/site-stamp.ts (check:sitestamp). Reasoning:
// docs/security.md, "the site-sign stamp".
//
// Absent SITE_NOSTR_SK => 503, so the feature is simply off when unconfigured
// (the checkbox still shows; the note just isn't posted). Mirrors the graceful
// degradation used elsewhere (e.g. the non-fatal Libre postinstall).


/** Ceiling on the inbound body — see `readCappedRequestText`. */
const MAX_REQUEST_BYTES = 32 * 1024;

async function handlePost(req: Request) {
  const limited = rateLimit(req, 'site-sign', 30);
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

  const mac = stampMac();
  if (!mac) {
    return NextResponse.json({ error: 'site Nostr identity not configured' }, { status: 503 });
  }

  return withErrorHandling(async () => {
    // Read with a cap, then parse. `req.json()` buffers first and measures
    // never — and this route is UNAUTHENTICATED at 30 requests a minute per
    // IP, which makes it the one with the least standing between a caller and
    // the instance's heap. The bound is far above any real template: the
    // validator already refuses content over 5500 characters and total
    // tag bytes over 4096.
    const read = await readCappedRequestJson(req, MAX_REQUEST_BYTES);
    if (!read.ok) return read.response;
    const { template: raw, stamp, legacy } = splitSignBody(read.body);
    let template: EventTemplate;
    // ONE OF THE TWO `e.message` REFLECTIONS IN THIS APP (the other is the same
    // call in /api/nostr/site-stamp), and it is safe only because of what this
    // `try` contains: exactly one call, whose every throw is a string literal
    // written in `validateBoostTemplate` (lib/site-sign-template.ts). `httpUrl`
    // returns `null` rather than throwing, so nothing in there reaches a
    // library error either.
    //
    // KEEP IT THAT WAY. `lib/api-handler.ts`'s rule is that an unhandled 500
    // returns its `fallback`, never `e.message`, because `PiHttpError` carries
    // Podcast Index's raw body and `assertSafeFetchUrl` names the host it
    // refused — reflecting either turns the SSRF guard into an oracle, on an
    // UNAUTHENTICATED route at 30/min. A validator that grows a parse, a
    // decode, or any call that can throw something the author did not write
    // silently converts this line into that oracle. Add such a call and this
    // must go back to a fixed string.
    try {
      // Only a LEGACY body keeps the ±5-minute window: a stamped one's
      // `created_at` is bound inside its token (see the validator).
      template = validateBoostTemplate(raw, site, { checkCreatedAt: legacy });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'invalid template' },
        { status: 400 },
      );
    }
    const gate = stampGate(stamp, legacy, siteEventId(template, site), {
      requireStamp: requireStamp(),
      mac,
      nowSecs: Math.floor(Date.now() / 1000),
    });
    if (gate.kind === 'refuse') {
      return NextResponse.json({ error: gate.error }, { status: gate.status });
    }
    if (gate.kind === 'check') {
      if (!stampAddressConfigured()) {
        return NextResponse.json({ error: 'note stamps are not configured' }, { status: 503 });
      }
      let paid: boolean;
      try {
        paid = await stampInvoicePaid(gate.verifyUrl);
      } catch {
        return NextResponse.json({ error: STAMP_UNCONFIRMED }, { status: 502 });
      }
      if (!paid) return NextResponse.json({ error: STAMP_NOT_PAID }, { status: 402 });
    }
    const signed = finalizeEvent(template, sk);
    return NextResponse.json(
      { event: signed },
      { headers: NO_STORE },
    );
  }, 'site-sign failed');
}

// Cross-brand CORS (lib/cross-brand-cors.ts): the Bitch site's browser calls
// this route on the Buddy deploy. Headers go on EVERY answer, errors included.
export async function POST(req: Request) {
  return withCors(req, await handlePost(req));
}

export function OPTIONS(req: Request) {
  return corsPreflight(req);
}
