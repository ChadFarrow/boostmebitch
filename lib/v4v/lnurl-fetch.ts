// The one way this app reads an LNURL-pay endpoint.
//
// Direct first, then `/api/lnurl`. Both `lib/v4v/lnaddr.ts` (the boost leg) and
// `lib/v4v/zap.ts` (the NIP-57 leg) go through here so they cannot drift about
// which providers they can reach — they had four bare `fetch` calls between
// them, and every one of them was unreachable for the same provider.

import { readCappedText, readCappedJson } from '../capped-body';

/**
 * Ceiling on an LNURL reply. The same number `/api/lnurl` enforces on the proxied
 * path — a payRequest is a few hundred bytes and an invoice a few KB, so this is
 * far above any real answer. The direct read is in the BROWSER, in the origin
 * that holds the NWC spending credential, against a host the feed named: an
 * unbounded `res.text()` there was the one third-party body this app read
 * without a cap. Over the cap throws inside the `try` below and falls through
 * to the proxy, which applies the same ceiling and answers non-2xx.
 */
const LNURL_MAX_BYTES = 256 * 1024;
/** The proxy's envelope wraps the same text, plus a status. */
const LNURL_ENVELOPE_MAX_BYTES = 512 * 1024;

/** What a direct fetch would have given us, whichever route produced it. */
export interface LnurlResponse {
  ok: boolean;
  status: number;
  /** The body verbatim. Callers parse it — an LNURL error is often not JSON. */
  text: string;
}

function shape(status: number, text: string): LnurlResponse {
  return { ok: status >= 200 && status < 300, status, text };
}

/** The same test `app/api/lnurl/route.ts` makes before it calls `safeFetch`. */
function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Fetch an LNURL-pay URL, falling back to this origin's proxy when the browser
 * cannot read the response.
 *
 * **Direct is the normal path and must stay first.** LNURL is browser-facing by
 * design and nearly every provider sends `Access-Control-Allow-Origin: *`, so
 * going straight to them keeps our server out of the money path, keeps the
 * user's typed boost message off it, and costs no extra hop inside a payment
 * the user is waiting on. Making the proxy unconditional would give all three
 * away to fix a minority of providers.
 *
 * The minority is real. Reported live: `livewire.io` answers
 * `/.well-known/lnurlp/reflex` with a 302 to a host carrying no CORS header, so
 * the browser blocks the read and the leg failed on **every** rail — LNURL is
 * the one rail every wallet supports, so there was nothing left to fall back
 * to. `app/api/keysend/route.ts` and `docs/money-boosts.md` both used to assert
 * that lnurlp endpoints "universally" send CORS headers. They do not.
 *
 * **The fallback triggers on a THROW, never on a non-2xx.** A 404 or a 400 is
 * the provider answering, and answering is exactly what the proxy is not needed
 * for; re-asking through our server would double the latency of every genuine
 * rejection and tell us the same thing. A throw is the case where the browser
 * refused to let us look: CORS, DNS, connection refused, offline. Those are one
 * indistinguishable `TypeError` in every browser, which is fine — retrying all
 * of them through the proxy costs a fast second failure and rescues the one
 * that matters.
 *
 * **Retrying is safe here in a way that retrying a payment is not.** Reading a
 * `.well-known` is idempotent, and asking a callback for an invoice does not
 * move money — it mints a BOLT11 that expires unpaid if nobody pays it. Money
 * moves later, once, when the rail pays the invoice this returns. Do not
 * generalise this to anything downstream of that.
 */
export async function lnurlFetch(url: string): Promise<LnurlResponse> {
  // The same `https:`-only test the server twin makes before `safeFetch`
  // (`app/api/lnurl/route.ts`). This is the one third-party URL the BROWSER
  // dials directly — the `callback` the provider chose — so the SSRF rules,
  // which are all written about server-side fetches, do not reach it either
  // way. No exploit is claimed: mixed-content blocking and Private Network
  // Access already stop the interesting targets from an https page, and the
  // body is only read through `readCappedText` and surfaced as an error string.
  // The point is that the two halves of one function should not disagree about
  // which schemes they dial, and that the fallback below would refuse with a
  // 400 anyway — so this fails in the same place for the same stated reason.
  // It THROWS rather than returning a shaped answer, because this module's own
  // rule two screens down is that a failure which is not the provider answering
  // must not be shaped like one — a caller that printed `text` would be
  // attributing our refusal to the LN service.
  if (!isHttps(url)) throw new Error('lnurl url must be https');
  try {
    // No timeout, deliberately: there was none before this module existed, and
    // adding one here would fail a slow-but-working provider mid-boost to fix a
    // problem nobody reported. The failures this exists for — a blocked
    // cross-origin read, a dead name — reject fast on their own.
    const res = await fetch(url);
    return shape(res.status, await readCappedText(res, LNURL_MAX_BYTES));
  } catch (direct) {
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      /* unparseable: the proxy will refuse it and say so */
    }
    // Say it out loud. This path runs for a small minority of providers, which
    // is exactly the kind of code that rots unnoticed — and when it does run,
    // "the boost was slow" and "the boost went through our server" are worth
    // being able to tell apart in a console someone pasted.
    console.info(
      `[lnurl] ${host || url} → proxy (direct fetch blocked: ${
        direct instanceof Error ? direct.message : String(direct)
      })`,
    );
    let res: Response;
    try {
      res = await fetch('/api/lnurl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // In the body, not the query string: this URL carries the user's boost
        // message and, on a zap, their signed event. See the route.
        body: JSON.stringify({ url }),
      });
    } catch (proxyErr) {
      throw both(direct, proxyErr);
    }
    if (!res.ok) {
      // Our own route failed — a 429, a refused URL, an SSRF block. That is not
      // the provider answering, so it must not be shaped like one: returning it
      // as an LnurlResponse would let the caller print our rate limiter's body
      // to the user as the LN service's reason.
      throw both(direct, new Error(`proxy returned ${res.status}`));
    }
    const env = (await readCappedJson(res, LNURL_ENVELOPE_MAX_BYTES)) as { status?: unknown; text?: unknown };
    if (typeof env?.status !== 'number' || typeof env?.text !== 'string') {
      throw both(direct, new Error('proxy returned an unreadable envelope'));
    }
    return shape(env.status, env.text);
  }
}

// Name BOTH failures. The direct one is the diagnosis — "CORS" or "NetworkError"
// is what says this provider needs the proxy at all — and reporting only the
// second sends the reader to look at our own route for a fault that is upstream.
function both(direct: unknown, proxy: unknown): Error {
  const a = direct instanceof Error ? direct.message : String(direct);
  const b = proxy instanceof Error ? proxy.message : String(proxy);
  return new Error(`direct: ${a}; proxy: ${b}`);
}
