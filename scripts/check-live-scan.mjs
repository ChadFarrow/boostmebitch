// Pins the LIVE read of a feed too large to keep whole: `readPrefixThenScan`
// (lib/capped-body.ts) and `liveReadDocument` (lib/feed-xml.ts), the two halves
// `readLiveFeedBody` in lib/pi.ts composes for `/api/live-shows`,
// `/api/live-status`, `/api/live-value`, the show page's live items and the
// 15-minute known-live check.
//
// THE FAILURE THIS IS WRITTEN AGAINST. Measured 2026-11-25 on Chad's iPhone:
// `/live` showed three LIVE cards, all UNCHECKED, two of them "Global Voice
// Radio Network… Radio Ranch with Roger Sayles Offlin…". Global Voice's Podhome
// feed was 11.9 MB with 2,400 episodes, and every feed read is capped at 8 MB
// (`readCappedText` THROWS past it), so each live read of it failed and
// `mergeLiveOverPi` kept Podcast Index's two rows on PI's word alone. Both were
// wrong: 112526 had become a plain `<item>`, and 112626 was `pending` for the
// next day. The publisher's own feed said so in its first 12 KB. `naive()` below
// is that old read: the capped read, whole or nothing.
//
// THE MISTAKE THE FIX MUST NOT MAKE. Keeping only a prefix would be easy, and
// wrong in the expensive direction: an `ok` live read is authoritative about
// which items EXIST (check:livemerge), so a live item past the cut would be
// deleted from the page while it is on air. A prefix proves presence, never
// absence. So the rest of the body is scanned for `podcast:liveItem`, and any
// mention past the cut — a live item, the close of one cut in half, even a
// false alarm in CDATA — makes the read unreadable, as it was before. The scan
// carries `needle.length - 1` bytes across every seam; the `scan` vectors replay
// a scan WITHOUT that carry, which is the obvious wrong one.
//
// The fixture is the real feed's first 21,947 bytes, verbatim (CRLF and BOM
// included): the channel head, its three live items, and the first `<item>` —
// the 112526 replay PI listed as live. The vectors cut it with a small `keep` in
// place of 8 MB, which is the same arithmetic at a size a repo can hold.
import { readFileSync } from 'node:fs';
import { readPrefixThenScan, readCappedText } from '../lib/capped-body.ts';
import { liveReadDocument, LIVE_ITEM_TAG, findBlocks } from '../lib/feed-xml.ts';
import { importFreeProblems, explainImportFree } from './import-free.mjs';
import { replayVectors } from './replay-vectors.mjs';

let failed = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failed++; };
const ok = (msg) => console.log('  ok    ' + msg);

const problems = importFreeProblems('lib/capped-body.ts');
if (problems.length) {
  explainImportFree('lib/capped-body.ts', problems);
  failed++;
}

const FEED = new Uint8Array(readFileSync(new URL('./fixtures/live-scan-podhome.xml', import.meta.url)));
const enc = new TextEncoder();
const text = new TextDecoder().decode(FEED);
const at = (s, from = 0) => {
  const i = indexOfBytes(FEED, enc.encode(s), from);
  if (i < 0) throw new Error(`fixture lost ${JSON.stringify(s)}`);
  return i;
};
function indexOfBytes(hay, pat, from) {
  outer: for (let i = from; i <= hay.length - pat.length; i++) {
    for (let j = 0; j < pat.length; j++) if (hay[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
}

// Byte offsets in the real feed, found rather than typed.
const LIVE3_OPEN = at('<podcast:liveItem status="pending" start="2026-11-26');
const LAST_LIVE_CLOSE = at('</podcast:liveItem>', LIVE3_OPEN) + '</podcast:liveItem>'.length;
const FIRST_ITEM = at('<item>', LAST_LIVE_CLOSE);
const GUIDS = ['a032c04c-2a99-4b5b-bad3-0f13cdbbc515', 'bcf0cf06-b10c-459a-97e0-181d91c26d46', 'a549e562-9f36-425a-83d3-6a62731cc13f'];
// The fixture really is what the comment says: three live items, then 112526.
if (findBlocks(text, LIVE_ITEM_TAG).length !== 3) fail('fixture: expected the feed\'s three live items');
if (!text.slice(FIRST_ITEM).includes('a8cde0e3-acd2-4e0c-ab5d-96e3d3496fbc')) fail('fixture: lost the 112526 <item>');

/** A CappableBody streaming `bytes` in chunks of `size` (all at once when 0). */
function body(bytes, size = 0, headers = {}) {
  const chunks = [];
  if (!size) chunks.push(bytes);
  else for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
  return {
    headers: new Headers(headers),
    body: new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } }),
    arrayBuffer: async () => bytes.slice().buffer,
  };
}
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const guidsOf = (xml) => findBlocks(xml, LIVE_ITEM_TAG)
  .map((b) => (b.inner.match(/<guid[^>]*>([^<]*)<\/guid>/) || [])[1] ?? '?');

// ── The two implementations, per kind ───────────────────────────────────────
//
// `live`: the whole decision, as an outcome string. `unreadable` is both a
// `null` and a throw, because lib/pi.ts treats them the same (stale copy, or
// `ok: false`). The live-only document is summarized by its guids, in order.
async function liveReal({ bytes, chunk, keep, max, headers }) {
  try {
    const read = await readPrefixThenScan(body(bytes, chunk, headers), keep, max, LIVE_ITEM_TAG);
    const doc = liveReadDocument(new TextDecoder().decode(read.bytes), read);
    if (!doc) return 'unreadable';
    return `${doc.whole ? 'whole' : 'live-only'}:${guidsOf(doc.xml).join(',')}`;
  } catch {
    return 'unreadable';
  }
}
// The read before this fix: `readCappedText` at the cap, whole or nothing.
async function liveNaive({ bytes, chunk, keep, headers }) {
  try {
    const xml = await readCappedText(body(bytes, chunk, headers), keep);
    return `whole:${guidsOf(xml).join(',')}`;
  } catch {
    return 'unreadable';
  }
}

// `scan`: the reader alone. The naive one searches each piece past the cut on
// its own — no carry — so a needle split across a seam goes unseen.
async function scanReal({ bytes, chunk, keep, max, needle }) {
  try {
    const r = await readPrefixThenScan(body(bytes, chunk), keep, max, needle);
    return `${r.bytes.length}:${r.truncated}:${r.needleAfterKept}`;
  } catch (e) {
    return `throw:${String(e.message).slice(0, 30)}`;
  }
}
async function scanNaive({ bytes, chunk, keep, max, needle }) {
  if (bytes.length > max) return 'throw:response too large (exceeded';
  const pat = needle.toLowerCase();
  const pieces = [];
  if (!chunk) pieces.push(bytes); else for (let i = 0; i < bytes.length; i += chunk) pieces.push(bytes.subarray(i, i + chunk));
  let kept = 0;
  let found = false;
  for (const p of pieces) {
    const room = keep - kept;
    const rest = room > 0 ? p.subarray(Math.min(room, p.length)) : p;
    kept += Math.min(Math.max(room, 0), p.length);
    if (rest.length && new TextDecoder('latin1').decode(rest).toLowerCase().includes(pat)) { found = true; break; }
  }
  return `${Math.min(kept, keep)}:${bytes.length > keep}:${found}`;
}

const MAX = 1024 * 1024;
const LIVE_BLOCK = FEED.subarray(LIVE3_OPEN, LAST_LIVE_CLOSE);

const VECTORS = [
  // ── live ──
  {
    label: 'the real feed, cut after its live items → those items, and every one of them',
    kind: 'live',
    args: { bytes: FEED, chunk: 4096, keep: FIRST_ITEM + 100, max: MAX },
    expect: `live-only:${GUIDS.join(',')}`,
  },
  {
    label: 'the same feed in 1-byte chunks (every seam is a chunk seam)',
    kind: 'live',
    args: { bytes: FEED, chunk: 1, keep: FIRST_ITEM + 100, max: MAX },
    expect: `live-only:${GUIDS.join(',')}`,
  },
  {
    label: 'a declared Content-Length past the keep is still read for its live items',
    kind: 'live',
    args: { bytes: FEED, chunk: 4096, keep: FIRST_ITEM + 100, max: MAX, headers: { 'content-length': String(FEED.length) } },
    expect: `live-only:${GUIDS.join(',')}`,
  },
  {
    label: 'the cut lands INSIDE the last live item → unreadable (its close is past the cut)',
    kind: 'live',
    args: { bytes: FEED, chunk: 4096, keep: LIVE3_OPEN + 200, max: MAX },
    expect: 'unreadable',
    alsoNaive: true,
  },
  {
    label: 'a live item AFTER the episodes, past the cut → unreadable, never "no such item"',
    kind: 'live',
    args: { bytes: join(FEED, LIVE_BLOCK), chunk: 4096, keep: FIRST_ITEM + 100, max: MAX },
    expect: 'unreadable',
    alsoNaive: true,
  },
  {
    label: 'that live item in UPPER CASE past the cut → still unreadable',
    kind: 'live',
    args: { bytes: join(FEED, enc.encode('<PODCAST:LIVEITEM status="live"><guid>x</guid></PODCAST:LIVEITEM>')), chunk: 4096, keep: FIRST_ITEM + 100, max: MAX },
    expect: 'unreadable',
    alsoNaive: true,
  },
  {
    label: 'a body under the keep is the whole feed, as before (must still work)',
    kind: 'live',
    args: { bytes: FEED, chunk: 4096, keep: FEED.length, max: MAX },
    expect: `whole:${GUIDS.join(',')}`,
    alsoNaive: true,
  },
  {
    label: 'a body past the total ceiling is refused (must still refuse)',
    kind: 'live',
    args: { bytes: FEED, chunk: 4096, keep: FIRST_ITEM + 100, max: FEED.length - 1 },
    expect: 'unreadable',
    alsoNaive: true,
  },
  {
    label: 'a declared Content-Length past the ceiling is refused before reading (must still refuse)',
    kind: 'live',
    args: { bytes: FEED, chunk: 4096, keep: FIRST_ITEM + 100, max: FEED.length - 1, headers: { 'content-length': String(FEED.length) } },
    expect: 'unreadable',
    alsoNaive: true,
  },
  // ── scan ──
  {
    label: 'the needle split across two chunks past the cut is found',
    kind: 'scan',
    args: { bytes: join(enc.encode('x'.repeat(40)), enc.encode('..<podcast:liveItem>..')), chunk: 47, keep: 10, max: MAX, needle: LIVE_ITEM_TAG },
    expect: '10:true:true',
  },
  {
    label: 'the needle split across the CUT itself is found (carry seeded from the kept prefix)',
    kind: 'scan',
    args: { bytes: enc.encode('aaaa<podcast:liveItem/>'), chunk: 0, keep: 12, max: MAX, needle: LIVE_ITEM_TAG },
    expect: '12:true:true',
  },
  {
    label: 'a needle wholly inside the kept prefix is not reported past it (must still work)',
    kind: 'scan',
    args: { bytes: enc.encode('<podcast:liveItem/>' + 'z'.repeat(30)), chunk: 5, keep: 25, max: MAX, needle: LIVE_ITEM_TAG },
    expect: '25:true:false',
    alsoNaive: true,
  },
  {
    label: 'no needle anywhere: whole prefix kept, rest read, nothing found (must still work)',
    kind: 'scan',
    args: { bytes: enc.encode('q'.repeat(100)), chunk: 7, keep: 30, max: MAX, needle: LIVE_ITEM_TAG },
    expect: '30:true:false',
    alsoNaive: true,
  },
];

// The readers are async and the replay compares synchronously, so every call
// runs first and the replay reads the answers.
const answers = new Map();
for (const v of VECTORS) {
  const real = v.kind === 'live' ? await liveReal(v.args) : await scanReal(v.args);
  const naive = v.kind === 'live' ? await liveNaive(v.args) : await scanNaive(v.args);
  answers.set(v, { real, naive });
  if (real === v.expect) ok(`${v.label} → ${real}`);
  else fail(`${v.label}\n          expected ${v.expect}\n          got      ${real}`);
}
replayVectors({ vectors: VECTORS, invoke: (which, v) => answers.get(v)[which], fail });

// The memory claim: what is KEPT never exceeds `keep`, however long the body.
{
  const big = join(FEED, new Uint8Array(200_000).fill(0x20));
  const r = await readPrefixThenScan(body(big, 8192), FIRST_ITEM, MAX, LIVE_ITEM_TAG);
  if (r.bytes.length === FIRST_ITEM && r.truncated && !r.needleAfterKept) ok('keeps exactly `keep` bytes of a longer body');
  else fail(`kept ${r.bytes.length} (want ${FIRST_ITEM}), truncated ${r.truncated}, needle ${r.needleAfterKept}`);
}

if (failed) {
  console.error(`\ncheck:livescan — ${failed} failure(s)`);
  process.exit(1);
}
console.log('\ncheck:livescan — all green');
