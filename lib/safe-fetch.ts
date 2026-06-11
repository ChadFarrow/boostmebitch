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
