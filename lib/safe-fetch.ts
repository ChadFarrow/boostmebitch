// Server-side SSRF guard for fetches of URLs that originate in untrusted
// data (PI feed entries, RSS <podcast:remoteItem feedUrl> attributes).
//
// TWO LAYERS, and the second one is why the first is not enough:
//
//   1. `assertSafeFetchUrl(raw)` — sync, pure, pinned by `npm run check:ssrf`.
//      Rejects non-http(s) schemes, private hostnames, and private IP
//      *literals*.
//   2. `safeFetch` additionally RESOLVES the hostname and re-runs the IP checks
//      on every address DNS returns, per redirect hop.
//
// Layer 2 exists because layer 1 alone was bypassed by a plain DNS record, and
// the attacker doesn't even have to own one: `nip.io` and `localtest.me` are
// public wildcard resolvers, so `http://127.0.0.1.nip.io/` is a public
// hostname, passes every literal check here, and resolves to loopback.
// `/api/transcript` hands the response body back verbatim, so that was a *read*
// SSRF primitive, not a blind one.
//
// RESIDUAL RISK, stated plainly: this is resolve-then-fetch, so undici
// re-resolves when it dials. A DNS server that answers our lookup with a public
// address and the dial with a private one (classic rebinding) still gets
// through. Closing that needs a custom dialer/agent pinning the validated
// address, which is a bigger change than this module wants. What layer 2 does
// close is the whole static "hostname that simply points at a private IP" class,
// which is the one that needs no attacker infrastructure at all.
//
// http is allowed: a long tail of real podcast RSS feeds is still plain-http.
import { lookup } from 'node:dns/promises';

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  // 100.64.0.0/10 — RFC 6598 carrier-grade NAT, and the range Tailscale hands
  // out for its mesh. A self-hoster running this alongside a tailnet would
  // otherwise have every node on it reachable through our feed/chapter proxies.
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^(?:22[4-9]|23\d)\./, // 224.0.0.0/4 multicast
  /^(?:24\d|25[0-5])\./, // 240.0.0.0/4 reserved, incl. 255.255.255.255 broadcast
  // IETF special-use ranges. None is routable on the public internet, so no
  // real podcast host lives here, and each is a plausible internal target.
  /^192\.0\.0\./, // 192.0.0.0/24 IETF protocol assignments
  /^192\.0\.2\./, // TEST-NET-1 (RFC 5737)
  /^198\.51\.100\./, // TEST-NET-2
  /^203\.0\.113\./, // TEST-NET-3
  /^198\.1[89]\./, // 198.18.0.0/15 benchmarking (RFC 2544)
  /^192\.88\.99\./, // 6to4 relay anycast, deprecated by RFC 7526
];

// IPv6 forms that reach loopback / link-local / an embedded IPv4. The original
// list covered `::1`, `::`, fe80::/10, fc00::/7 and `::ffff:` v4-mapped — but
// several encodings route somewhere private without matching any of them, and
// each was verified to pass the old guard:
//
//   ::7f00:1          IPv4-COMPATIBLE (deprecated) form of 127.0.0.1
//   64:ff9b::7f00:1   NAT64 well-known prefix — 127.0.0.1 on a NAT64 network
//   64:ff9b::a9fe:a9fe    …and 169.254.169.254, i.e. cloud metadata
//   2002:7f00:1::     6to4 encoding of 127.0.0.1
//   fec0::1           site-local (deprecated, still resolvable on old networks)
//
// Rather than decode each embedded IPv4 — a second parser, and a second place
// to get it wrong — the whole of each prefix is refused. All five are
// deprecated or special-purpose, so nothing legitimate is lost.
const PRIVATE_V6 = [
  /^::$/, // unspecified
  // Everything under `::/96` — `::1` loopback, and every IPv4-compatible
  // address (`::7f00:1`). `::ffff:x` v4-mapped is a subcase and stays covered.
  /^::(?!$)/,
  /^fe[89a-f]/i, // fe80::/10 link-local AND fec0::/10 site-local
  /^f[cd]/i, // fc00::/7 unique-local
  /^64:ff9b:/i, // NAT64 well-known prefix (RFC 6052 / 8215)
  /^2002:/i, // 6to4 (embeds an arbitrary IPv4)
  /^2001:0?:/i, // Teredo 2001::/32 (also embeds an IPv4)
  /^100:/i, // 100::/64 discard-only
];

/**
 * Is this a bare IP address that must never be fetched server-side?
 *
 * Shared by the literal check and the post-DNS check so the two can't disagree
 * about what "private" means — a denylist maintained in two places is a
 * denylist with a hole in it.
 */
export function isPrivateIp(addr: string): boolean {
  const ip = addr.toLowerCase().replace(/^\[|\]$/g, '');
  if (ip.includes(':')) return PRIVATE_V6.some((re) => re.test(ip));
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return PRIVATE_V4.some((re) => re.test(ip));
  return false;
}

/** Throws when `raw` isn't a safe public http(s) URL to fetch server-side. */
export function assertSafeFetchUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`unsafe fetch url (unparseable): ${raw.slice(0, 120)}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`unsafe fetch url (protocol ${u.protocol})`);
  }
  // Strip the trailing dot(s) of a fully-qualified name BEFORE any comparison.
  // DNS treats `metadata.google.internal.` as identical to
  // `metadata.google.internal`, but `.endsWith('.internal')` is false for it —
  // so a single extra character defeated every check below, including the one
  // guarding cloud metadata endpoints. Same trick worked on `localhost.`.
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error(`unsafe fetch url (private host): ${host}`);
  }
  // IP literals. The URL parser keeps the brackets on an IPv6 hostname in some
  // runtimes; `isPrivateIp` normalizes them away. Everything here is a literal
  // — a hostname that RESOLVES to one of these ranges is caught later, by
  // `assertResolvedHostSafe`, because no sync check can see it.
  if (isPrivateIp(host)) {
    throw new Error(`unsafe fetch url (private address): ${host}`);
  }
}

/**
 * Resolve `host` and reject if ANY address DNS hands back is private.
 *
 * "Any", not "the first": a name with several A records is safe only if every
 * one of them is, since we don't control which the dialer picks.
 *
 * An IP literal short-circuits — `assertSafeFetchUrl` already checked it, and
 * asking the resolver about it just burns a syscall.
 */
export async function assertResolvedHostSafe(host: string): Promise<void> {
  if (isPrivateIp(host)) {
    throw new Error(`unsafe fetch url (private address): ${host}`);
  }
  // A bare literal needs no lookup. Anything with a colon is IPv6; a dotted
  // quad is IPv4. Both were cleared above.
  if (host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return;

  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    // Resolution failed. Refuse rather than hand the name to `fetch` and hope —
    // fail closed is the whole posture of this module, and an unresolvable host
    // was never going to serve a feed anyway.
    throw new Error(`unsafe fetch url (unresolvable host): ${host}`);
  }
  for (const { address } of addrs) {
    if (isPrivateIp(address)) {
      throw new Error(`unsafe fetch url (host resolves to a private address): ${host}`);
    }
  }
}

const MAX_REDIRECTS = 5;

/** 8 MB. Larger than any real RSS feed, chapters file or transcript. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Read a response body as text, refusing anything past `maxBytes`.
 *
 * `AbortSignal.timeout(...)` — which every caller here passes — caps how LONG a
 * fetch may run, not how much it may return. Eight seconds of a fast upstream is
 * hundreds of megabytes, and the URL is feed-supplied, so `await res.text()`
 * handed an attacker a way to fill a serverless instance's heap from one
 * request. Worse where the result is then cached: `lib/pi.ts` retains feed XML
 * keyed by that same URL.
 *
 * Streams and aborts mid-body rather than buffering first and measuring after,
 * which would defeat the point. `Content-Length` is only a fast path — it is
 * absent on chunked responses and trivially lied about, so the byte count while
 * reading is what actually enforces the limit.
 */
export async function readCappedText(
  res: Response,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<string> {
  return new TextDecoder().decode(await readCappedBytes(res, maxBytes));
}

/**
 * Read at most `maxBytes` and **stop**, rather than refusing the response.
 *
 * The distinction from {@link readCappedBytes} is the whole point: that one
 * throws past the cap, which is right when a partial body is worthless (a
 * half-read feed is not a feed). Here a prefix is exactly what the caller
 * wants — `/api/og/boost.png` needs the first frame of an animated GIF, which
 * sits at the front of the file, and a real one measured 606 KB inside a 19 MB
 * episode artwork. Reading the prefix and cancelling costs 0.6 MB instead of 19.
 *
 * `truncated` says whether more was available, so a caller can tell "the whole
 * file, which happens to be small" from "as much as you allowed" — those need
 * different handling and the byte count alone cannot separate them.
 *
 * Cancelling the reader is what actually aborts the transfer; without it the
 * rest of the body keeps arriving on a socket nobody reads.
 */
export async function readBytesUpTo(
  res: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    return all.byteLength > maxBytes
      ? { bytes: all.subarray(0, maxBytes), truncated: true }
      : { bytes: all, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - total;
      if (value.byteLength >= room) {
        chunks.push(value.subarray(0, room));
        total += room;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  return { bytes: joined, truncated };
}

/**
 * {@link readCappedText}'s byte half — the same streaming cap, without the
 * decode. Artwork is binary, and `TextDecoder` over a PNG returns replacement
 * characters, so a caller that needs the bytes cannot go through the text
 * reader and must not fall back to a bare `res.arrayBuffer()`: that buffers the
 * whole body first and measures after, which is the behaviour this module
 * exists to prevent. One capping loop, two shapes on top of it.
 */
export async function readCappedBytes(
  res: Response,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response too large (${declared} bytes, max ${maxBytes})`);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`response too large (exceeded ${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    // Releases the socket on the throw path too — an abandoned reader keeps the
    // connection half-open against the pool.
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  return joined;
}

/** {@link readCappedText}, then `JSON.parse`. */
export async function readCappedJson(
  res: Response,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<unknown> {
  return JSON.parse(await readCappedText(res, maxBytes));
}

/**
 * `fetch` that re-runs {@link assertSafeFetchUrl} on **every** hop.
 *
 * The plain guard only validates the initial URL; with the default
 * `redirect: 'follow'` a public feed/chapter/transcript host can 302 to an
 * internal address (`http://169.254.169.254/…`, `localhost`, an RFC-1918 host)
 * and the response is proxied straight back — a full SSRF bypass of the guard
 * this module exists to enforce. We follow redirects manually (Node/undici
 * exposes the 3xx + `Location` under `redirect: 'manual'`), validating each
 * target before the next request. Relative `Location` values resolve against
 * the current hop. Caps the chain so a redirect loop can't spin forever.
 *
 * Any per-request `redirect` in `init` is overridden — callers can't opt back
 * into automatic (unvalidated) following.
 *
 * Each hop is checked twice: the sync literal/scheme guard, then the DNS
 * resolution guard. The second one has to run per hop for the same reason the
 * first does — a public host redirecting to `http://127.0.0.1.nip.io/` is the
 * same bypass as one redirecting to `http://127.0.0.1/`, just spelled in DNS.
 */
export async function safeFetch(rawUrl: string, init?: RequestInit): Promise<Response> {
  let url = rawUrl;
  for (let hop = 0; ; hop++) {
    assertSafeFetchUrl(url);
    await assertResolvedHostSafe(new URL(url).hostname.toLowerCase().replace(/\.+$/, ''));
    const res = await fetch(url, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;
    const loc = res.headers.get('location');
    if (!loc) return res; // 3xx without a target — hand it back as-is
    if (hop >= MAX_REDIRECTS) throw new Error('unsafe fetch url (too many redirects)');
    url = new URL(loc, url).toString();
  }
}
