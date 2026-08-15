// Pins the SSRF guard that stands between untrusted feed URLs and this
// server's network position.
//
// Usage:
//   npm run check:ssrf
//
// Every URL fetched server-side from third-party data — RSS feeds, chapter
// JSON, transcripts, <podcast:remoteItem feedUrl> — goes through
// assertSafeFetchUrl, and safeFetch re-runs it on every redirect hop. On a
// cloud host the prize for getting past it is the instance metadata endpoint
// (169.254.169.254 / metadata.google.internal), i.e. credentials.
//
// The BLOCKED list is the regression suite. Three of these were live bypasses:
//
//   http://localhost./                  trailing dot beat every hostname check
//   http://metadata.google.internal./   ...including the metadata guard
//   http://100.64.1.1/                  CGNAT / Tailscale range was unlisted
//
// Imports lib/safe-fetch.ts directly via --experimental-strip-types so this
// exercises production code rather than a copy.
//
// SCOPE: this pins `assertSafeFetchUrl`, the SYNC half — schemes, hostnames and
// IP literals. It is deliberately pure so it can be asserted offline.
//
// `safeFetch` has a second layer, `assertResolvedHostSafe`, which resolves the
// hostname and re-runs the same IP checks on every address DNS returns. That
// one is NOT asserted here because it needs a live resolver, and a check script
// that fails on a plane is a check script people start skipping. It shares
// `isPrivateIp` with this half, so every range pinned below is a range it
// enforces too — which is exactly why that predicate is one exported function
// and not two lists.
//
// Both layers together still leave TOCTOU rebinding open: we resolve, then
// undici resolves again when it dials. Closing that needs a custom dialer
// pinning the validated address. Documented at the top of lib/safe-fetch.ts.

import { assertSafeFetchUrl } from '../lib/safe-fetch.ts';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); return; }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
  failures++;
};

const allows = (url) => {
  try { assertSafeFetchUrl(url); return true; } catch { return false; }
};

const BLOCKED = [
  ['localhost',                'http://localhost/'],
  ['localhost trailing dot',   'http://localhost./'],
  ['localhost double dot',     'http://localhost../'],
  ['sub.localhost',            'http://foo.localhost/'],
  ['sub.localhost + dot',      'http://foo.localhost./'],
  ['mDNS .local',              'http://nas.local/'],
  ['mDNS .local + dot',        'http://nas.local./'],
  ['GCP metadata',             'http://metadata.google.internal/'],
  ['GCP metadata + dot',       'http://metadata.google.internal./'],
  ['AWS/link-local metadata',  'http://169.254.169.254/latest/meta-data/'],
  ['loopback dotted',          'http://127.0.0.1/'],
  ['loopback decimal',         'http://2130706433/'],
  ['loopback octal',           'http://0177.0.0.1/'],
  ['loopback hex',             'http://0x7f000001/'],
  ['0.0.0.0',                  'http://0.0.0.0/'],
  ['RFC1918 10/8',             'http://10.1.2.3/'],
  ['RFC1918 172.16/12',        'http://172.20.0.1/'],
  ['RFC1918 192.168/16',       'http://192.168.1.1/'],
  ['CGNAT 100.64/10 low',      'http://100.64.0.1/'],
  ['CGNAT 100.64/10 high',     'http://100.127.255.254/'],
  ['Tailscale 100.100.x',      'http://100.100.100.100/'],
  ['multicast 224/4',          'http://224.0.0.1/'],
  ['multicast 239.x',          'http://239.255.255.250/'],
  ['reserved 240/4',           'http://240.0.0.1/'],
  ['broadcast',                'http://255.255.255.255/'],
  ['IPv6 loopback',            'http://[::1]/'],
  ['IPv6 unspecified',         'http://[::]/'],
  ['IPv6 link-local',          'http://[fe80::1]/'],
  ['IPv6 ULA',                 'http://[fc00::1]/'],
  ['IPv4-mapped IPv6',         'http://[::ffff:127.0.0.1]/'],
  // IPv6 encodings that route somewhere private WITHOUT matching any of the
  // patterns above. Every one of these passed the guard until the whole of each
  // prefix was refused — decoding the embedded IPv4 instead would have meant a
  // second address parser and a second place to get it wrong.
  ['IPv4-compatible IPv6',     'http://[::7f00:1]/'],            // 127.0.0.1
  ['NAT64 loopback',           'http://[64:ff9b::7f00:1]/'],     // 127.0.0.1
  ['NAT64 metadata',           'http://[64:ff9b::a9fe:a9fe]/'],  // 169.254.169.254
  ['6to4 loopback',            'http://[2002:7f00:1::]/'],       // 127.0.0.1
  ['IPv6 site-local',          'http://[fec0::1]/'],
  ['Teredo',                   'http://[2001:0:1:2::]/'],
  ['discard-only 100::/64',    'http://[100::1]/'],
  // IETF special-use IPv4. None is routable, so none can be a real podcast host,
  // and each is a plausible internal target.
  ['192.0.0.0/24 IETF',        'http://192.0.0.1/'],
  ['TEST-NET-1',               'http://192.0.2.5/'],
  ['TEST-NET-2',               'http://198.51.100.5/'],
  ['TEST-NET-3',               'http://203.0.113.5/'],
  ['benchmarking 198.18/15',   'http://198.18.0.1/'],
  ['6to4 relay anycast',       'http://192.88.99.1/'],
  ['file: scheme',             'file:///etc/passwd'],
  ['gopher: scheme',           'gopher://evil/'],
  ['unparseable',              'not a url at all'],
];

console.log('Must be BLOCKED — these reach internal network position');
for (const [label, url] of BLOCKED) {
  check(label, !allows(url), `assertSafeFetchUrl allowed ${url}`);
}

// Over-blocking breaks real podcast feeds, which is a quieter but real failure.
// http is intentionally allowed: a long tail of podcast RSS is still plain-http.
const ALLOWED = [
  ['https public',        'https://example.com/feed.xml'],
  ['http public',         'http://feeds.example.com/rss'],
  ['public IPv4',         'http://93.184.216.34/feed.xml'],
  ['port + path + query', 'https://example.com:8443/a/b?c=1'],
  ['100.x outside CGNAT', 'http://100.63.255.255/'],
  ['100.128 above CGNAT', 'http://100.128.0.1/'],
  ['172.15 below RFC1918','http://172.15.0.1/'],
  ['172.32 above RFC1918','http://172.32.0.1/'],
  ['223.x below multicast','http://223.255.255.255/'],
  ['public IPv6',         'http://[2606:4700::1111]/'],
  // Boundaries just outside each range added for the IPv6/special-use pass.
  // These matter as much as the BLOCKED half: the cheap way to "fix" a bypass
  // is to widen a prefix until it swallows real hosts, and nothing else here
  // would notice.
  ['2001: public (Google DNS)', 'http://[2001:4860:4860::8888]/'], // NOT Teredo
  ['2003: above 6to4',    'http://[2003::1]/'],
  ['65:: above NAT64',    'http://[65:ff9b::1]/'],
  ['192.0.1 above IETF',  'http://192.0.1.1/'],
  ['192.0.3 above TEST-NET-1', 'http://192.0.3.1/'],
  ['198.17 below bench',  'http://198.17.255.255/'],
  ['198.20 above bench',  'http://198.20.0.1/'],
  ['192.88.98 below 6to4 relay', 'http://192.88.98.1/'],
  ['192.88.100 above 6to4 relay', 'http://192.88.100.1/'],
  ['203.0.114 above TEST-NET-3', 'http://203.0.114.1/'],
  ['198.51.101 above TEST-NET-2', 'http://198.51.101.1/'],
];

console.log('\nMust be ALLOWED — ordinary podcast hosts');
for (const [label, url] of ALLOWED) {
  check(label, allows(url), `assertSafeFetchUrl rejected ${url}`);
}

if (failures > 0) {
  console.error(
    `\n${failures} check(s) FAILED.\n\n` +
      'A BLOCKED failure means untrusted feed data can point this server at an\n' +
      'internal address — on a cloud host that means the metadata endpoint and\n' +
      'the credentials it serves. Fix lib/safe-fetch.ts; do not relax this list.\n\n' +
      'An ALLOWED failure means the guard is now rejecting real podcast feeds.',
  );
  process.exitCode = 1;
} else {
  console.log('\nAll SSRF guard checks passed.');
}
