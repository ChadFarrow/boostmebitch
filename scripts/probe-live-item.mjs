// Watch a live show's <podcast:liveItem> and report what changes, per track.
//
// Usage:
//   npm run probe:live -- <feedUrl> [--interval 15] [--minutes 120]
//
// Why this exists: there is no "live valueTimeSplit" tag. A <podcast:valueTimeSplit>
// is anchored to startTime/duration offsets into a finished enclosure, and a
// live stream has no absolute time base to sync those to — so the convention
// that ships is that the publisher REWRITES the live item mid-broadcast. Which
// PART they rewrite is not standardised, and differs per publishing tool. This
// script answers that question empirically for a given show instead of us
// guessing: run it during a real broadcast and watch which row moves.
//
//   A  <podcast:remoteItem>   — an explicit "now playing" pointer
//   B  <podcast:value>        — the value block rewritten in place
//   C  <podcast:valueTimeSplit>
//   D  <title>                — often the only thing that moves
//
// Deliberately does NOT interpret value semantics: it diffs the raw bytes of
// each signal. That keeps it free of any parser copy that could drift from
// lib/pi.ts and tell you something the app doesn't actually do. What the app
// makes of the feed is a separate question, answered by /api/live-value.
//
// Read-only: fetches and prints. It writes nothing and pays nothing. Plain
// fetch rather than lib/safe-fetch.ts because the URL comes from the operator's
// own command line, not from third-party feed data — the SSRF guard exists for
// the server paths where it doesn't.

const args = process.argv.slice(2);
const feedUrl = args.find((a) => !a.startsWith('--'));
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(args[i + 1]) || dflt;
};
const intervalSec = flag('interval', 15);
const minutes = flag('minutes', 120);

if (!feedUrl) {
  console.error('usage: npm run probe:live -- <feedUrl> [--interval 15] [--minutes 120]');
  process.exit(2);
}

const LIVE_ITEM_RE = /<podcast:liveItem\b([^>]*)>([\s\S]*?)<\/podcast:liveItem>/gi;

/** Pull one signal's raw text out of a live item's inner XML. */
function signals(inner) {
  const all = (re) => (inner.match(re) ?? []).join('\n').replace(/\s+/g, ' ').trim();
  return {
    A_remoteItem: all(/<podcast:remoteItem\b[^>]*?\/?>/gi),
    B_value: all(/<podcast:value\b[^>]*>[\s\S]*?<\/podcast:value>|<podcast:value\b[^>]*\/>/gi),
    C_valueTimeSplit: all(/<podcast:valueTimeSplit\b[^>]*>[\s\S]*?<\/podcast:valueTimeSplit>|<podcast:valueTimeSplit\b[^>]*\/>/gi),
    D_title: all(/<title\b[^>]*>[\s\S]*?<\/title>/gi),
  };
}

function guidOf(inner) {
  const m = inner.match(/<guid\b[^>]*>([\s\S]*?)<\/guid>/i);
  return (m ? m[1] : '').trim() || '(no guid)';
}

function statusOf(attrs) {
  const m = attrs.match(/\bstatus\s*=\s*"([^"]*)"|\bstatus\s*=\s*'([^']*)'/i);
  return (m ? m[1] ?? m[2] : '') || '?';
}

const clock = () => new Date().toTimeString().slice(0, 8);
const short = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** guid → { signals, changes: {name: count}, lastChangeMs } */
const seen = new Map();
let polls = 0;
const changeGaps = [];

async function poll() {
  polls += 1;
  let xml;
  try {
    const res = await fetch(feedUrl, {
      headers: { 'User-Agent': 'boostmebitch-probe/0.1' },
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } catch (e) {
    console.log(`${clock()}  ✗ fetch failed: ${e.message}`);
    return;
  }

  LIVE_ITEM_RE.lastIndex = 0;
  let m;
  let found = 0;
  while ((m = LIVE_ITEM_RE.exec(xml))) {
    found += 1;
    const [, attrs, inner] = m;
    const guid = guidOf(inner);
    const status = statusOf(attrs);
    const now = signals(inner);
    const prev = seen.get(guid);

    if (!prev) {
      console.log(`\n${clock()}  ▸ live item  status=${status}  guid=${guid}`);
      for (const [k, v] of Object.entries(now)) {
        console.log(`            ${v ? '●' : '○'} ${k.padEnd(18)} ${v ? short(v) : '(absent)'}`);
      }
      seen.set(guid, { signals: now, changes: {}, lastChangeMs: Date.now() });
      continue;
    }

    const changed = Object.keys(now).filter((k) => now[k] !== prev.signals[k]);
    if (changed.length) {
      const gap = Date.now() - prev.lastChangeMs;
      changeGaps.push(gap);
      console.log(`\n${clock()}  ⇄ CHANGED after ${Math.round(gap / 1000)}s  status=${status}`);
      for (const k of changed) {
        prev.changes[k] = (prev.changes[k] ?? 0) + 1;
        console.log(`            ${k}`);
        console.log(`              was: ${short(prev.signals[k]) || '(absent)'}`);
        console.log(`              now: ${short(now[k]) || '(absent)'}`);
      }
      prev.signals = now;
      prev.lastChangeMs = Date.now();
    }
  }
  if (found === 0 && polls === 1) {
    console.log(`${clock()}  no <podcast:liveItem> in this feed (is the show live?)`);
  }
}

function summary() {
  console.log('\n──── summary ────');
  console.log(`polls: ${polls}`);
  for (const [guid, s] of seen) {
    const counts = Object.entries(s.changes);
    console.log(`\nlive item ${guid}`);
    if (!counts.length) {
      console.log('  nothing changed — this feed does not switch value live,');
      console.log('  or the show was not broadcasting during the run.');
      continue;
    }
    for (const [k, n] of counts.sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(18)} changed ${n}×`);
    }
  }
  if (changeGaps.length) {
    const sorted = [...changeGaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] / 1000;
    console.log(`\nmedian gap between changes: ${Math.round(median)}s`);
    if (median < intervalSec * 2) {
      console.log(`⚠ that is close to the ${intervalSec}s poll interval — the app's`);
      console.log('  20s poller will miss tracks on this feed.');
    }
  }
  console.log('\nWhichever row above changes is the signal this feed uses.');
  console.log('A/C are handled by resolveLiveSplit; B needs two polls to be');
  console.log('distinguishable from a show that simply has one value block.');
}

console.log(`probing ${feedUrl} every ${intervalSec}s for ${minutes}m — ctrl-c to stop`);
await poll();
const timer = setInterval(() => { void poll(); }, intervalSec * 1000);
setTimeout(() => { clearInterval(timer); summary(); process.exit(0); }, minutes * 60_000);
process.on('SIGINT', () => { clearInterval(timer); summary(); process.exit(0); });
