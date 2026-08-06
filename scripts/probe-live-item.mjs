// Watch a live show's <podcast:liveItem> and report what changes, per track.
//
// Usage:
//   npm run probe:live -- <feedUrl> [--interval 15] [--minutes 120]
//
// Why this exists: there is no "live valueTimeSplit" tag. A <podcast:valueTimeSplit>
// is anchored to startTime/duration offsets into a finished enclosure, and a
// live stream has no absolute time base to sync those to. Shows switch wallets
// either by publishing a PUSH channel (<podcast:liveValue>, what The Split Kit
// emits) or by REWRITING part of the live item per track — and which part is
// not standardised. This script answers that empirically for a given show
// instead of us guessing: run it during a real broadcast and watch which row
// moves.
//
//   L  <podcast:liveValue>    — a PUSH channel (The Split Kit). If this is
//                               present, the feed itself never changes: the
//                               target arrives over a socket. Run the app and
//                               watch the network tab instead.
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
// When the feed publishes <podcast:liveValue>, the probe ALSO connects to that
// socket and dumps every pushed block verbatim, then runs the real
// parseLiveBlock over it and prints exactly who BoostMeBitch would pay. That is
// the check that matters during a broadcast: not "did we parse something" but
// "is the artist we resolved the artist on stage".
//
// Read-only: fetches, listens and prints. It writes nothing and pays nothing.
// Plain fetch rather than lib/safe-fetch.ts because the URL comes from the
// operator's own command line, not from third-party feed data — the SSRF guard
// exists for the server paths where it doesn't.

import { parseLiveBlock } from '../lib/v4v/live-block.ts';

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

/** guid → socket disposer, so one connection per live item. */
const sockets = new Map();
let pushes = 0;

function liveValueAttrs(inner) {
  const m = inner.match(/<podcast:liveValue\b([^>]*?)\/?>/i);
  if (!m) return null;
  const attr = (n) => {
    const a = m[1].match(new RegExp(`\\b${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
    return a ? (a[1] ?? a[2]) : undefined;
  };
  const uri = attr('uri');
  return uri ? { uri, protocol: (attr('protocol') || '').toLowerCase() } : null;
}

/**
 * Listen to a show's live-value channel and report what the app would do with
 * each push. Uses the SHIPPING parseLiveBlock, so a mapping bug shows up here
 * rather than during a boost.
 */
async function listenLiveValue(guid, lv) {
  if (sockets.has(guid)) return;
  sockets.set(guid, () => {});
  if (lv.protocol !== 'socket.io') {
    console.log(`${clock()}  ⚠ liveValue protocol="${lv.protocol}" is not socket.io — the app ignores this`);
    return;
  }
  let io;
  try {
    ({ io } = await import('socket.io-client'));
  } catch {
    console.log('  ✗ socket.io-client not installed — run `npm install` first');
    return;
  }
  console.log(`${clock()}  ⇢ connecting to liveValue socket: ${lv.uri}`);
  const socket = io(lv.uri, { transports: ['websocket', 'polling'] });
  sockets.set(guid, () => { try { socket.disconnect(); } catch { /* gone */ } });

  socket.on('connect', () => console.log(`${clock()}  ✓ liveValue socket connected`));
  socket.on('connect_error', (e) => console.log(`${clock()}  ✗ liveValue connect_error: ${e?.message ?? e}`));
  socket.on('disconnect', (r) => console.log(`${clock()}  · liveValue disconnected (${r})`));
  socket.on('playerPause', () => console.log(`${clock()}  · playerPause`));

  socket.on('remoteValue', (data) => {
    pushes += 1;
    console.log(`\n${clock()}  ★ remoteValue #${pushes} — RAW PAYLOAD`);
    console.log(JSON.stringify(data, null, 2));
    const block = parseLiveBlock(data);
    if (!block) {
      const empty = !data || (typeof data === 'object' && !Object.keys(data).length);
      console.log('  → parseLiveBlock: null — app falls back to the show\'s own block');
      console.log(empty
        ? '    Payload is empty, which is Split Kit\'s "back to the default block". Expected between sets.'
        : '    Payload is NOT empty, so this one did not map. If a track is playing right now,'
          + '\n    that is a bug in parseLiveBlock — send the payload above.');
      return;
    }
    console.log(`  → would pay: ${block.title ?? '(untitled)'}`);
    console.log(`    remote guids: ${block.feedGuid ?? '(none)'} / ${block.itemGuid ?? '(none)'}`);
    console.log(`    remotePercentage: ${block.remotePercentage ?? '(none — defaults to 100)'}`);
    for (const r of block.value.recipients) {
      console.log(`      ${r.type.padEnd(9)} split=${String(r.split).padStart(3)}${r.fee ? ' (fee)' : ''}  ${r.name ?? ''} ${r.address}`);
    }
    console.log('    ↑ compare against who is actually on stage right now.');
  });
}

/** Pull one signal's raw text out of a live item's inner XML. */
function signals(inner) {
  const all = (re) => (inner.match(re) ?? []).join('\n').replace(/\s+/g, ' ').trim();
  return {
    L_liveValue: all(/<podcast:liveValue\b[^>]*?\/?>/gi),
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
      const lv = liveValueAttrs(inner);
      if (lv) void listenLiveValue(guid, lv);
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
  console.log(`polls: ${polls}   liveValue pushes: ${pushes}`);
  for (const close of sockets.values()) close();
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
  const anyLiveValue = [...seen.values()].some((s) => s.signals.L_liveValue);
  if (anyLiveValue) {
    console.log('\nThis feed publishes <podcast:liveValue> — a PUSH channel.');
    console.log('The target arrives over a socket, so the feed bytes staying');
    console.log('still is EXPECTED and does not mean the show is not switching.');
  } else {
    console.log('\nWhichever row above changes is the signal this feed uses.');
    console.log('A/C are handled by resolveLiveSplit; B needs two polls to be');
    console.log('distinguishable from a show that simply has one value block.');
  }
}

console.log(`probing ${feedUrl} every ${intervalSec}s for ${minutes}m — ctrl-c to stop`);
await poll();
const timer = setInterval(() => { void poll(); }, intervalSec * 1000);
setTimeout(() => { clearInterval(timer); summary(); process.exit(0); }, minutes * 60_000);
process.on('SIGINT', () => { clearInterval(timer); summary(); process.exit(0); });
