import { NextResponse } from 'next/server';
import { withErrorHandling } from '@/lib/api-handler';
import { rateLimit } from '@/lib/rate-limit';
import { readCappedText, readCappedJson } from '@/lib/safe-fetch';

// Server-side proxy for the BoostBox metadata service.
// Defaults match the public reference instance so the integration works
// out of the box; override via env to point at a self-hosted deployment.
//
// `v4v4me` is NOT a leaked credential — it is the public reference instance's
// published shared key, which is why it also sits in .env.example. Left in place
// deliberately: removing it breaks zero-config setup and protects nothing.
// Don't "fix" it by deleting the fallback; if you run a private BoostBox, set
// BOOSTBOX_API_KEY and the env value wins.
//
// BOOSTBOX_URL is interpolated into the fetch below without going through
// safeFetch. That's sound only because it's operator-supplied env, not feed
// data — the one outbound in this app that isn't attacker-influenceable. Keep
// it that way: never let a request parameter reach it.
const BOOSTBOX_URL = process.env.BOOSTBOX_URL || 'https://tardbox.com';
const BOOSTBOX_API_KEY = process.env.BOOSTBOX_API_KEY || 'v4v4me';

/**
 * PER-LEG, not per-user-action — which is why this is 120 and not 30.
 *
 * `payLnurl` POSTs here once for every LNURL leg, and `<BoostAllModal>` calls
 * `sendBoost` twice per track (track legs, then host legs), so a 12-track album
 * with two LNURL recipients plus a host leg is ~36 requests in one run. At 30 the
 * limit bit from leg 31 and the *later tracks* were the ones that lost their
 * metadata. The peer route is `/api/keysend` (120), the other one called once per
 * leg — 30 is the tier for `site-sign`, `publisher` and `value-splits`, all of
 * which fire once per user action.
 *
 * Getting rate-limited here is silent and total for the recipient:
 * `storeBoostMetadata` returns null on any non-2xx without distinguishing a 429,
 * so `buildLnurlComment` falls back to the bare message — no descriptor, payment
 * succeeds, nothing logged. `<BoostCard>` still renders the BoostBox link from
 * `BoostResult.boostboxUrl`, so it looks correct in the sender's own history
 * while the recipient got nothing machine-readable.
 *
 * 120 is a ceiling, not a target: legs are paid SERIALLY (never parallelize —
 * see CLAUDE.md), so each POST is followed by a real Lightning payment. A minute
 * of boosting can't physically produce more than ~30-60 legs, which is both why
 * 30 bit and why 120 leaves room without letting one IP hammer the upstream.
 */
const BOOSTBOX_RATE_LIMIT = 120;

export async function POST(req: Request) {
  const limited = rateLimit(req, 'boostbox', BOOSTBOX_RATE_LIMIT);
  if (limited) return limited;
  return withErrorHandling(async () => {
    const raw = await req.text();
    if (raw.length > 10_000) {
      return NextResponse.json({ error: 'payload too large' }, { status: 400 });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      // A malformed body is the client's fault — 400, not a 500 via the handler.
      return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    // Shape check before forwarding. Without one this route relays ANY JSON
    // under 10 KB to a third party stamped with our API key — an open relay
    // whose consequences land on the upstream's trust in that key, not on us.
    // Deliberately a shape check and not a full schema: the BoostBox payload is
    // the upstream's to define, so validating field-by-field here would drift
    // against it. Requiring a plain object with the one field the endpoint is
    // named for is enough to stop it being a general-purpose pipe.
    if (
      !payload
      || typeof payload !== 'object'
      || Array.isArray(payload)
      || typeof (payload as { action?: unknown }).action !== 'string'
    ) {
      return NextResponse.json({ error: 'invalid boost payload' }, { status: 400 });
    }
    const upstream = await fetch(`${BOOSTBOX_URL}/boost`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': BOOSTBOX_API_KEY,
      },
      body: JSON.stringify(payload),
      // Shorter than the client's own budget (lib/v4v/boostbox.ts) so this
      // route answers before the caller aborts — same relationship
      // app/api/keysend has with keysend-lookup.ts. This runs inside a boost
      // the user is waiting on, with the legs paid serially behind it, so an
      // unbounded upstream stalls the whole send.
      signal: AbortSignal.timeout(4500),
    });

    if (!upstream.ok) {
      // The upstream's body goes to OUR log, not back to the caller — it's a
      // third party's internals, and BoostBox failure is non-fatal anyway
      // (lib/v4v/boostbox.ts falls back to the bare message), so nothing on the
      // client acts on `detail`.
      // Capped, not `upstream.text()` then `.slice(500)`. Slicing after the read
      // measures the string we already allocated: an upstream having a bad day
      // and returning an HTML error page buffers the whole page into this
      // process first, and only then throws 500 chars of it at the log. The
      // repo rule is capped reads on every proxied body, and the argument holds
      // hardest on the error path, which is exactly where a body stops being
      // the small JSON the happy path expects.
      const detail = await readCappedText(upstream, 4096).catch(() => '');
      // eslint-disable-next-line no-console
      console.error(`[boostbox] upstream ${upstream.status}:`, detail.slice(0, 500));
      return NextResponse.json(
        { error: `BoostBox error: ${upstream.status}` },
        { status: upstream.status },
      );
    }

    // The success body is one small object — a `desc` BoostBox has already
    // truncated against Lightning's 639-char description limit. 64 KB is orders
    // of magnitude more than that and still a bound; `upstream.json()` is none
    // at all, and this runs inside a boost the user is waiting on.
    const data = await readCappedJson(upstream, 64 * 1024);
    return NextResponse.json(data);
  }, 'BoostBox proxy failed');
}
