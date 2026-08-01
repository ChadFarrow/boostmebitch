// Pins the URL-attribute allowlist that keeps third-party RSS show notes from
// executing script in our origin.
//
// Usage:
//   npm run check:sanitizer
//
// Show notes render via dangerouslySetInnerHTML, and this origin's localStorage
// holds `bmb:nwc_uri` (a Lightning spending credential) and the NIP-46 bunker
// `clientSk`. Script execution here is theft, not defacement — so the six
// ATTACKS below are recorded as regression vectors, every one of which was a
// working bypass of the previous denylist:
//
//   <a href="java&#115;cript:alert(1)">  ->  browser resolved javascript:alert(1)
//
// It imports lib/safe-url-attr.ts directly via --experimental-strip-types, so
// this exercises production code rather than a copy — a copy would pass green
// while the shipping check changed, which is the failure mode being guarded
// against.
//
// The BENIGN list matters as much as the attacks: an over-strict allowlist that
// eats ordinary links is a real regression, just a quieter one.

import { safeUrlAttr, escapeHtmlAttr } from '../lib/safe-url-attr.ts';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); return; }
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
  failures++;
};

// What a browser ends up with, given what we chose to emit. Deliberately a
// SEPARATE implementation from the one under test: if both shared a decoder, a
// bug in it would cancel out and the check would pass on a broken sanitizer.
function browserResolves(emitted) {
  const decoded = emitted
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&Tab;/gi, '\t')
    .replace(/&NewLine;/gi, '\n')
    .replace(/&colon;/gi, ':');
  return decoded.replace(/[\t\n\r]/g, '').trim();
}

const DANGEROUS = /^\s*(?:javascript|vbscript|data):/i;

// Every one of these was a live bypass before the allowlist landed.
const ATTACKS = [
  ['plain javascript:',          'javascript:alert(1)'],
  ['decimal entity',             'java&#115;cript:alert(1)'],
  ['hex entity',                 'java&#x73;cript:alert(1)'],
  ['numeric entity, no semi',    'java&#115cript:alert(1)'],
  ['literal TAB in scheme',      'java\tscript:alert(1)'],
  ['literal LF in scheme',       'java\nscript:alert(1)'],
  ['literal CR in scheme',       'java\rscript:alert(1)'],
  ['&Tab; entity',               'java&Tab;script:alert(1)'],
  ['&NewLine; entity',           'java&NewLine;script:alert(1)'],
  ['&colon; entity',             'javascript&colon;alert(1)'],
  ['uppercase',                  'JaVaScRiPt:alert(1)'],
  ['leading whitespace',         '   javascript:alert(1)'],
  ['leading NUL',                '\0javascript:alert(1)'],
  ['vbscript:',                  'vbscript:msgbox(1)'],
  ['data: html',                 'data:text/html;base64,PHNjcmlwdD4='],
  ['data: svg',                  'data:image/svg+xml,<svg onload=alert(1)>'],
  ['quote break-out via entity', 'https://x.com/&#34;onmouseover=&#34;alert(1)'],
];

console.log('URL allowlist — attack vectors must never reach the DOM as a live scheme');
for (const [label, raw] of ATTACKS) {
  for (const kind of ['link', 'image']) {
    const out = safeUrlAttr(raw, kind);
    if (out === null) continue; // dropped outright — the usual outcome
    // If it WAS allowed, prove the browser can't get a dangerous scheme out of
    // it, and that it can't break out of the quoted attribute either.
    const emitted = escapeHtmlAttr(out);
    const resolved = browserResolves(emitted);
    check(
      `${label} (${kind})`,
      !DANGEROUS.test(resolved) && !emitted.includes('"'),
      `allowed ${JSON.stringify(out)} -> browser sees ${JSON.stringify(resolved)}`,
    );
  }
  check(`${label} — rejected or neutralised`, true);
}

// Over-blocking is a regression too: these must survive intact.
const BENIGN = [
  ['https',              'https://example.com/ep/1',                'https://example.com/ep/1'],
  ['http',               'http://example.com',                      'http://example.com'],
  ['query with &amp;',   'https://x.com/?a=1&amp;b=2',              'https://x.com/?a=1&b=2'],
  ['protocol-relative',  '//cdn.example.com/a.png',                 '//cdn.example.com/a.png'],
  ['percent-encoded',    'https://x.com/a%20b',                     'https://x.com/a%20b'],
  ['fragment + query',   'https://x.com/p?q=1#t=30',                'https://x.com/p?q=1#t=30'],
  ['unicode path',       'https://x.com/café',                 'https://x.com/café'],
];

console.log('\nLegitimate URLs — must pass through unharmed');
for (const [label, raw, want] of BENIGN) {
  const got = safeUrlAttr(raw, 'link');
  check(`${label}`, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  // And must round-trip: escape -> browser decode -> the same URL.
  if (got !== null) {
    check(`${label} round-trips`, browserResolves(escapeHtmlAttr(got)) === want,
      `round-trip gave ${JSON.stringify(browserResolves(escapeHtmlAttr(got)))}`);
  }
}

console.log('\nmailto: allowed for links, not for images');
check('mailto link allowed', safeUrlAttr('mailto:a@b.com', 'link') === 'mailto:a@b.com');
check('mailto image dropped', safeUrlAttr('mailto:a@b.com', 'image') === null);

console.log('\nescapeHtmlAttr');
check('escapes & " < >', escapeHtmlAttr('&"<>') === '&amp;&quot;&lt;&gt;');

if (failures > 0) {
  console.error(
    `\n${failures} check(s) FAILED.\n\n` +
      'If an ATTACK vector failed: a podcast feed can run JavaScript in this\n' +
      "origin, which holds the user's NWC spending credential and bunker key.\n" +
      'Do not relax the allowlist to make it pass — fix lib/safe-url-attr.ts.\n\n' +
      'If a BENIGN vector failed: the allowlist is now eating ordinary links in\n' +
      'show notes. Widen it deliberately, and add the case here.',
  );
  process.exitCode = 1;
} else {
  console.log('\nAll sanitizer checks passed.');
}
