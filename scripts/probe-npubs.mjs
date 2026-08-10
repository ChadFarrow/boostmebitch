// Show what a real feed's <podcast:txt> tags are, and which of them BoostMeBitch
// would p-tag on a boost note.
//
// Usage:
//   npm run probe:npubs -- <feedUrl>
//
// Why this exists: `npm run check:npub` pins the parser against synthetic
// vectors, which proves the rules are implemented but not that a given
// publisher wrote the tag the way we expect. Feeds in the wild disagree about
// `purpose` spelling, put the tag at item level only, or ship an nprofile where
// the spec wants an npub — and every one of those looks identical from here
// (no npubs found) unless you can see the raw tags. So this prints BOTH: every
// <podcast:txt> in the feed verbatim, then the subset that survives validation.
//
// A tag listed under RAW but missing from RESOLVED is the interesting case;
// the reason is always one of: purpose isn't "nostr", the value isn't a
// decodable npub, or it's an nprofile/note rather than an npub.
//
// Runs the REAL channelSlice + parseNostrTxtNpubs from lib/feed-xml.ts, so what
// it prints is what the app does. The one thing it re-states rather than
// imports is the <item> scanning regex, which lives inside two loops in
// lib/pi.ts; it's a scanner, not a parser, and the parse itself is the real one.
//
// Read-only: fetches and prints. It writes nothing and pays nothing. Plain
// fetch rather than lib/safe-fetch.ts because the URL comes from the operator's
// own command line, not from third-party feed data — the SSRF guard exists for
// the server paths where it doesn't.

import { channelSlice, parseNostrTxtNpubs } from '../lib/feed-xml.ts';

const feedUrl = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!feedUrl) {
  console.error('Usage: npm run probe:npubs -- <feedUrl>');
  process.exit(1);
}

const res = await fetch(feedUrl, { headers: { 'User-Agent': 'BoostMeBitch-probe/1.0' } });
if (!res.ok) {
  console.error(`fetch failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const xml = await res.text();

const channel = channelSlice(xml);
const ITEM_RE = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
const TXT_RE = /<podcast:txt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/podcast:txt>)/gi;

function rawTxtTags(scope) {
  const out = [];
  let m;
  const re = new RegExp(TXT_RE.source, 'gi');
  while ((m = re.exec(scope))) out.push(m[0]);
  return out;
}

function titleOf(itemXml) {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(itemXml);
  return m ? m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, '$1').trim() : '(untitled)';
}

console.log(`feed: ${feedUrl}`);
console.log(`${(xml.length / 1024).toFixed(0)} KB\n`);

console.log('=== CHANNEL (the show / album artist) ===');
const channelRaw = rawTxtTags(channel);
if (!channelRaw.length) console.log('  RAW      (no <podcast:txt> in the channel header)');
for (const t of channelRaw) console.log(`  RAW      ${t.replace(/\s+/g, ' ').trim()}`);
const channelNpubs = parseNostrTxtNpubs(channel);
if (!channelNpubs) {
  console.log('  RESOLVED (none — no boost note will p-tag a show-level npub)');
} else {
  for (const n of channelNpubs) console.log(`  RESOLVED ${n.npub}\n           p → ${n.pubkey}`);
}

console.log('\n=== ITEMS (per-track / per-episode artists) ===');
let m;
let itemsWithTags = 0;
let itemCount = 0;
while ((m = ITEM_RE.exec(xml))) {
  itemCount += 1;
  const inner = m[1];
  const raw = rawTxtTags(inner);
  const npubs = parseNostrTxtNpubs(inner);
  if (!raw.length && !npubs) continue;
  itemsWithTags += 1;
  console.log(`\n  ${titleOf(inner)}`);
  for (const t of raw) console.log(`    RAW      ${t.replace(/\s+/g, ' ').trim()}`);
  if (!npubs) console.log('    RESOLVED (none)');
  else for (const n of npubs) console.log(`    RESOLVED ${n.npub}\n             p → ${n.pubkey}`);
}
if (!itemsWithTags) console.log(`  (no <podcast:txt> in any of the ${itemCount} items)`);

console.log('\n=== WHAT A BOOST NOTE WOULD TAG ===');
if (!channelNpubs && !itemsWithTags) {
  console.log('  Nothing. This feed declares no nostr identity we can use.');
} else {
  console.log('  Show-level boost:  ' + (channelNpubs?.map((n) => n.npub).join(', ') ?? 'nothing'));
  console.log('  Episode boost:     that episode\'s npubs first, then the show\'s, deduped, capped at 4.');
}
