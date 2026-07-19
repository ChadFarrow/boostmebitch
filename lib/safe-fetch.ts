// Server-side SSRF guard for fetches of URLs that originate in untrusted
// data (PI feed entries, RSS <podcast:remoteItem feedUrl> attributes).
//
// Hostname/IP-literal checks only — no DNS resolution, so a public hostname
// that resolves to a private IP is NOT caught (DNS pinning would need a
// custom dialer; out of scope). http is allowed: a long tail of real podcast
// RSS feeds is still plain-http.

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

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
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error(`unsafe fetch url (private host): ${host}`);
  }
  if (host.includes(':')) {
    // IPv6 literal (URL keeps the brackets in hostname on some runtimes —
    // normalize them away). Loopback, unspecified, link-local fe80::/10,
    // ULA fc00::/7, v4-mapped.
    const v6 = host.replace(/^\[|\]$/g, '');
    if (
      v6 === '::1' ||
      v6 === '::' ||
      /^fe[89ab]/i.test(v6) ||
      /^f[cd]/i.test(v6) ||
      v6.startsWith('::ffff:')
    ) {
      throw new Error(`unsafe fetch url (private IPv6): ${host}`);
    }
  } else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && PRIVATE_V4.some((re) => re.test(host))) {
    throw new Error(`unsafe fetch url (private IPv4): ${host}`);
  }
}

const MAX_REDIRECTS = 5;

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
 */
export async function safeFetch(rawUrl: string, init?: RequestInit): Promise<Response> {
  let url = rawUrl;
  for (let hop = 0; ; hop++) {
    assertSafeFetchUrl(url);
    const res = await fetch(url, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;
    const loc = res.headers.get('location');
    if (!loc) return res; // 3xx without a target — hand it back as-is
    if (hop >= MAX_REDIRECTS) throw new Error('unsafe fetch url (too many redirects)');
    url = new URL(loc, url).toString();
  }
}
