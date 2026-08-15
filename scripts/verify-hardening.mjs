// Ad-hoc verification harness for the hardening branch.
//
// NOT a check:* script — those pin behaviour forever and run in the gate. This
// one exists to SHOW the fixes working, side by side with what the old code
// did, so a human can read the difference. Safe to delete once you've seen it.
//
//   node --experimental-strip-types scripts/verify-hardening.mjs
//
// Everything here runs offline. The parts that need a server or a browser are
// listed at the end rather than faked.

import { readAttr } from '../lib/feed-xml.ts';
import { assertSafeFetchUrl, isPrivateIp, readCappedText } from '../lib/safe-fetch.ts';

const pass = (s) => `  \x1b[32m✓\x1b[0m ${s}`;
const fail = (s) => `  \x1b[31m✗ ${s}\x1b[0m`;
let bad = 0;
const ok = (cond, msg) => { console.log(cond ? pass(msg) : fail(msg)); if (!cond) bad++; };

// The pre-fix implementation, so the difference is visible rather than asserted.
function oldReadAttr(attrs, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = attrs.match(re);
  return m ? (m[1] ?? m[2]) : undefined;
}

console.log('\n\x1b[1m1. readAttr — the payee-substitution fix\x1b[0m');
console.log('   lib/pi.ts:470 reads every value recipient through this function.\n');

// A <podcast:valueRecipient> a hostile feed could serve. Every OTHER Podcasting
// 2.0 client reads address= and sees the real artist.
const RECIPIENT =
  '<podcast:valueRecipient name="Real Artist" type="node" '
  + 'x-address="03ATTACKERNODEaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" '
  + 'address="03REALARTISTbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" '
  + 'w-split="1" split="100"/>';

for (const [field, want] of [['address', '03REALARTISTbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'], ['split', '100']]) {
  const before = oldReadAttr(RECIPIENT, field);
  const after = readAttr(RECIPIENT, field);
  console.log(`   ${field}:`);
  console.log(`     before: ${before}`);
  console.log(`     now:    ${after}`);
  ok(after === want && before !== want, `${field} resolves to the feed's real value (and used not to)`);
}

// The decoy alone must read as ABSENT, not as the decoy — otherwise "this
// recipient has no address, skip it" becomes "pay the attacker".
ok(readAttr('x-address="03ATTACKER"', 'address') === undefined, 'a lone decoy reads as absent, not as the decoy');
ok(readAttr('data-href="javascript:alert(1)"', 'href') === undefined, 'data-href does not satisfy an href lookup (show notes)');
ok(readAttr('x-feedUrl="https://evil/f.xml"', 'feedUrl') === undefined, 'x-feedUrl does not pick the album feed');

// Over-anchoring would empty every value block in the wild — the other failure.
ok(readAttr('address="03REAL"', 'address') === '03REAL', 'still reads an attribute at string start');
ok(readAttr('name="A"\n  address="03REAL"', 'address') === '03REAL', 'still reads across a newline');
ok(readAttr("address='03REAL'", 'address') === '03REAL', 'still reads single quotes');
ok(readAttr('type="lnaddress" address="artist@getalby.com"', 'address') === 'artist@getalby.com', 'still reads a real lnaddress');

console.log('\n\x1b[1m2. SSRF — IP literals and the ranges that were missing\x1b[0m\n');
const BLOCK = [
  ['http://127.0.0.1/', 'loopback'],
  ['http://169.254.169.254/', 'cloud metadata'],
  ['http://[::7f00:1]/', 'IPv4-compatible IPv6 → 127.0.0.1'],
  ['http://[64:ff9b::a9fe:a9fe]/', 'NAT64 → cloud metadata'],
  ['http://[2002:7f00:1::]/', '6to4 → 127.0.0.1'],
  ['http://[fec0::1]/', 'IPv6 site-local'],
  ['http://192.0.2.5/', 'TEST-NET-1'],
  ['http://198.18.0.1/', 'benchmarking range'],
  ['http://2130706433/', 'decimal loopback (was already safe)'],
];
for (const [url, label] of BLOCK) {
  let blocked = false;
  try { assertSafeFetchUrl(url); } catch { blocked = true; }
  ok(blocked, `blocked: ${label}`);
}
const ALLOW = [
  ['https://feeds.megaphone.fm/x.xml', 'ordinary podcast host'],
  ['http://93.184.216.34/feed.xml', 'public IPv4'],
  ['http://[2001:4860:4860::8888]/', 'public IPv6 starting 2001: (not Teredo)'],
  ['http://198.20.0.1/', 'just above the benchmarking range'],
];
for (const [url, label] of ALLOW) {
  let allowed = true;
  try { assertSafeFetchUrl(url); } catch { allowed = false; }
  ok(allowed, `still allowed: ${label}`);
}
ok(isPrivateIp('10.0.0.1') && !isPrivateIp('8.8.8.8'), 'isPrivateIp is shared by both layers and agrees with itself');

console.log('\n\x1b[1m3. Response size cap\x1b[0m\n');
{
  const withLen = new Response('x', { headers: { 'content-length': '99999999' } });
  let threw = false;
  try { await readCappedText(withLen, 1024); } catch { threw = true; }
  ok(threw, 'rejects an over-cap Content-Length without reading the body');

  const chunked = new Response(new ReadableStream({
    start(c) { for (let i = 0; i < 50; i++) c.enqueue(new Uint8Array(1000)); c.close(); },
  }));
  let threw2 = false;
  try { await readCappedText(chunked, 1024); } catch { threw2 = true; }
  ok(threw2, 'aborts mid-stream when no Content-Length is declared');

  // The bug this shape invites: decoding per chunk splits multi-byte characters.
  const text = 'é'.repeat(50_000);
  const round = await readCappedText(new Response(text));
  ok(round === text, 'multi-byte UTF-8 survives a chunk boundary intact');
  ok((await readCappedText(new Response('a'.repeat(1024)), 1024)).length === 1024, 'a body exactly at the cap is allowed');
}

console.log(bad === 0
  ? '\n\x1b[32mAll offline checks passed.\x1b[0m'
  : `\n\x1b[31m${bad} FAILED\x1b[0m`);

console.log(`
\x1b[1mNot covered here — needs a server or a browser:\x1b[0m
  • follows: toggle Follow with relays blocked → must show "↻ retry" and must
    NOT write bmb:follows:<npub> in localStorage.
  • modals: Escape, focus return, Tab trapping, no scroll behind (iOS).
  • lists.tsx race: switch shows fast on a throttled connection.
  See the checklist printed by the assistant, or docs/security.md.
`);
process.exit(bad ? 1 : 0);
