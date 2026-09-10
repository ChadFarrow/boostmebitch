// Pins `liveBroadcastIsOver` (lib/util.ts) — whether a `<podcast:liveItem>`
// still marked `live` is actually still on air.
//
// TWO FAILURES, IN OPPOSITE DIRECTIONS. Both are replayed here, and each has
// its own wrong implementation to be proved against.
//
// THE FIRST, measured 2026-09-06 on the live site. `/live` showed "Behind the
// Sch3m3s — S02E49: It's Alive!!" with a pulsing `● LIVE` badge and a working
// PLAY button. The feed really did say so:
//
//   <podcast:liveItem status="live"
//     start="2026-09-01T02:00:00.000Z"
//     end="2026-09-01T05:30:00.000Z">
//
// The publisher declared its own finish FIVE DAYS before, and never flipped the
// status. `status` is a flag a human sets, and humans forget — reported as
// "sometimes people forget to end the live". Rendering it faithfully is what
// puts a live badge over silence, on `/live` and on the show page both.
//
// This repo had already solved the same problem on the other protocol:
// `LIVE_FRESH_SECS` (lib/nostr/live-streams.ts) drops a kind:30311 event not
// updated within 2 h, because "most clients never publish the `ended` status —
// they just stop updating". RSS had no equivalent and did not even parse `end`.
//
// `naive()` is what shipped before that: trust `status`, full stop.
//
// THE SECOND, reported 2026-09-10 on Chad and Reed's Podcast, is what the FIX
// for the first one caused. That fix made `end` authoritative — an `end` in the
// past ended the broadcast, whatever the flag said. But `end` is a SCHEDULE,
// not a record. The liveItem declared `end` at 10:00 pm, the show was still on
// air at 10:39 pm, and a listener who tuned in then found no live row anywhere
// in the app. Nothing was stale; the hosts ran long, which is ordinary.
//
// A live show ends when it is ANNOUNCED — the publisher flips `status`, podping
// carries that to Podcast Index, and `/api/live-status` re-reads the feed every
// 45 s. So `status="live"` now outlives its own `end` by
// `LIVE_OVERRUN_GRACE_SECS`, and only a flag nobody flips is cut off.
//
// `endIsFinal()` is that intermediate version, and it is the one the 10:39 pm
// vectors have to beat. Keeping both wrong versions is the point: a rule that
// satisfies one failure and not the other is exactly what shipped twice.
//
// FIXTURE PROVENANCE. The `end`-bearing vectors are the real attribute values
// from three feeds read on 2026-09-06 — behindthesch3m3s.com (the first
// failure), music.behindthesch3m3s.com/Sat_Skirmish (3.5 h broadcasts, which is
// why the no-`end` ceiling cannot be the Nostr side's 2 h), and
// feed.homegrownhits.xyz (a `pending` item whose `end` is in the future) — plus
// the overrun offsets from the 2026-09-10 report.
import { liveBroadcastIsOver, MAX_UNBOUNDED_LIVE_SECS, LIVE_OVERRUN_GRACE_SECS } from '../lib/util.ts';

let failures = 0;
const fail = (m) => { console.error('  ✗ ' + m); failures++; };
const ok = (m) => console.log('  ok    ' + m);

// ── Wrong version 1: the status attribute is the whole answer ─────────────
function naive() { return false; }

// ── Wrong version 2: the feed's declared `end` is the whole answer ────────
// The shape that fixed the Sch3m3s badge and took a running show off the page.
function endIsFinal(item, nowSec) {
  if (typeof item.endTime === 'number' && Number.isFinite(item.endTime)) {
    return item.endTime < nowSec;
  }
  if (typeof item.startTime === 'number' && Number.isFinite(item.startTime)) {
    return nowSec - item.startTime > MAX_UNBOUNDED_LIVE_SECS;
  }
  return false;
}

// Each vector is replayed against BOTH, and a vector a wrong version also gets
// right is exempted one at a time — never by default, and the mark is checked
// in both directions so it cannot drift away from what the function does.
const WRONG = [
  { fn: naive, mark: 'alsoNaive', label: 'naive()' },
  { fn: endIsFinal, mark: 'alsoEndFinal', label: 'endIsFinal()' },
];

const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const NOW = sec('2026-09-06T15:00:00.000Z');
const HOUR = 3600;
const MIN = 60;

const VECTORS = [
  {
    name: 'THE FIRST FAILURE: status="live" whose declared end was five days ago',
    args: [{ status: 'live', startTime: sec('2026-09-01T02:00:00.000Z'), endTime: sec('2026-09-01T05:30:00.000Z') }, NOW],
    expect: true,
    alsoEndFinal: true,
  },
  {
    name: 'THE SECOND FAILURE: a live show 39 minutes past its declared end is ON AIR',
    // Chad and Reed's Podcast, 2026-09-10: end declared 10:00 pm, still
    // broadcasting at 10:39 pm, and the app showed the listener nothing.
    args: [{ status: 'live', startTime: NOW - 2 * HOUR - 39 * MIN, endTime: NOW - 39 * MIN }, NOW],
    expect: false,
    alsoNaive: true,
  },
  {
    name: 'a live show 5h59m past its end is still ON AIR',
    args: [{ status: 'live', startTime: NOW - 9 * HOUR, endTime: NOW - LIVE_OVERRUN_GRACE_SECS + MIN }, NOW],
    expect: false,
    alsoNaive: true,
  },
  {
    name: 'exactly the grace past the end is not yet over',
    args: [{ status: 'live', startTime: NOW - 9 * HOUR, endTime: NOW - LIVE_OVERRUN_GRACE_SECS }, NOW],
    expect: false,
    alsoNaive: true,
  },
  {
    name: 'a live flag an hour past the grace is gone — the backstop still bites',
    args: [{ status: 'live', startTime: NOW - 10 * HOUR, endTime: NOW - LIVE_OVERRUN_GRACE_SECS - HOUR }, NOW],
    expect: true,
    alsoEndFinal: true,
  },
  {
    name: 'the grace is measured from END, not from START — a 40h broadcast gets the same 6h',
    // Or a long show spends its own grace before it can overrun at all.
    args: [{ status: 'live', startTime: NOW - 40 * HOUR, endTime: NOW - HOUR }, NOW],
    expect: false,
    alsoNaive: true,
  },
  {
    name: 'a broadcast still inside its declared window is ON AIR',
    args: [{ status: 'live', startTime: NOW - HOUR, endTime: NOW + 2 * HOUR }, NOW],
    expect: false,
    alsoNaive: true,
    alsoEndFinal: true,
  },
  {
    name: 'a 3.5h Satellite Skirmish broadcast, one minute from its end, is ON AIR',
    // The must-still-work half: over-blocking is a regression too, and this is
    // the shape that would break first if the ceiling were applied over `end`.
    args: [{ status: 'live', startTime: NOW - 3.5 * HOUR, endTime: NOW + 60 }, NOW],
    expect: false,
    alsoNaive: true,
    alsoEndFinal: true,
  },
  {
    name: 'end exactly now is not yet past',
    args: [{ status: 'live', startTime: NOW - HOUR, endTime: NOW }, NOW],
    expect: false,
    alsoNaive: true,
    alsoEndFinal: true,
  },
  {
    name: 'no end, started 25h ago → over on the ceiling',
    args: [{ status: 'live', startTime: NOW - MAX_UNBOUNDED_LIVE_SECS - HOUR }, NOW],
    expect: true,
    alsoEndFinal: true,
  },
  {
    name: 'no end, started 12h ago → still on air (a podcast is not a Nostr stream)',
    args: [{ status: 'live', startTime: NOW - 12 * HOUR }, NOW],
    expect: false,
    alsoNaive: true,
    alsoEndFinal: true,
  },
  {
    name: 'the ceiling is not the Nostr side’s 2h — a 3h broadcast survives it',
    args: [{ status: 'live', startTime: NOW - 3 * HOUR }, NOW],
    expect: false,
    alsoNaive: true,
    alsoEndFinal: true,
  },
  {
    name: 'THE THIRD FAILURE: a PENDING window that closed 18 months ago',
    // Before The Sch3m3s, read 2026-09-06: scheduled for 2025-03-10, never
    // aired, never cleared, and sitting at the top of Upcoming under a start
    // date in the past. This vector is why a `pending` end stays final.
    args: [{ status: 'pending', startTime: sec('2025-03-10T01:00:00.000Z'), endTime: sec('2025-03-10T04:30:00.000Z') }, NOW],
    expect: true,
    alsoEndFinal: true,
  },
  {
    name: 'the overrun grace is for LIVE only — a PENDING item gets none',
    // Nothing about a `pending` item claims anybody is on air, so there is no
    // overrun to protect. A host who actually starts is `live` by then.
    args: [{ status: 'pending', startTime: NOW - 2 * HOUR - 39 * MIN, endTime: NOW - 39 * MIN }, NOW],
    expect: true,
    alsoEndFinal: true,
  },
  {
    name: 'a PENDING host running an hour late is still coming',
    // The case the old "pending is never over" rule existed to protect, and it
    // still holds: lateness is measured against `end`, which has not passed.
    args: [{ status: 'pending', startTime: NOW - HOUR, endTime: NOW + 2 * HOUR }, NOW],
    expect: false,
    alsoNaive: true,
    alsoEndFinal: true,
  },
  {
    name: 'a PENDING item with no end, an hour past its start, is still coming',
    args: [{ status: 'pending', startTime: NOW - HOUR }, NOW],
    expect: false,
    alsoNaive: true,
    alsoEndFinal: true,
  },
  {
    name: 'a PENDING item scheduled days out is not over',
    args: [{ status: 'pending', startTime: sec('2026-09-10T19:00:59.000Z'), endTime: sec('2026-09-11T12:00:00.000Z') }, NOW],
    expect: false,
    alsoNaive: true,
    alsoEndFinal: true,
  },
  {
    name: 'neither end nor start is not evidence of anything',
    args: [{ status: 'live' }, NOW],
    expect: false,
    alsoNaive: true,
    alsoEndFinal: true,
  },
  {
    name: 'a malformed end is ignored rather than treated as expired',
    args: [{ status: 'live', startTime: NOW - HOUR, endTime: NaN }, NOW],
    expect: false,
    alsoNaive: true,
    alsoEndFinal: true,
  },
  {
    name: 'a malformed end on an OVERDUE live item still falls to the ceiling',
    args: [{ status: 'live', startTime: NOW - 40 * HOUR, endTime: NaN }, NOW],
    expect: true,
    alsoEndFinal: true,
  },
  {
    name: 'the status attribute is matched case-insensitively',
    // PI lowercases its own, the RSS parser lowercases the attribute, and a
    // third caller that forgets would silently lose the grace.
    args: [{ status: 'LIVE', startTime: NOW - 2 * HOUR, endTime: NOW - 39 * MIN }, NOW],
    expect: false,
    alsoNaive: true,
  },
];

for (const v of VECTORS) {
  const got = liveBroadcastIsOver(...v.args);
  if (got !== v.expect) { fail(`${v.name} — expected ${v.expect}, got ${got}`); continue; }
  const beaten = [];
  let marksOk = true;
  for (const w of WRONG) {
    const agrees = w.fn(...v.args) === v.expect;
    if (agrees && !v[w.mark]) {
      fail(`${v.name} — ${w.label} passes it too, so this vector proves nothing\n`
        + `          against it. Mark it { ${w.mark}: true } or change the vector.`);
      marksOk = false;
    } else if (!agrees && v[w.mark]) {
      fail(`${v.name} — marked ${w.mark} but ${w.label} FAILS it. The mark is wrong.`);
      marksOk = false;
    } else if (!agrees) {
      beaten.push(w.label);
    }
  }
  if (marksOk) {
    ok(v.name + (beaten.length ? `  (beats ${beaten.join(', ')})` : '  (must-still-work)'));
  }
}

// The grace is a money-free number but a user-visible one, and a zero or a
// negative turns this straight back into `endIsFinal`.
if (!(LIVE_OVERRUN_GRACE_SECS > 0 && LIVE_OVERRUN_GRACE_SECS < MAX_UNBOUNDED_LIVE_SECS)) {
  fail(`LIVE_OVERRUN_GRACE_SECS is ${LIVE_OVERRUN_GRACE_SECS}s — it must be positive\n`
    + '          (or a running show is dropped at its scheduled end again) and under\n'
    + `          the ${MAX_UNBOUNDED_LIVE_SECS}s ceiling (or a declared end buys MORE\n`
    + '          time than declaring none).');
} else {
  ok(`the overrun grace is ${LIVE_OVERRUN_GRACE_SECS / 3600}h, inside its bounds`);
}

// A behavioural pin cannot see the parser dropping the call.
const fs = await import('node:fs/promises');
const pi = await fs.readFile('lib/pi.ts', 'utf8');
if (!pi.includes('liveBroadcastIsOver')) {
  fail('lib/pi.ts no longer calls liveBroadcastIsOver — a forgotten `live` flag\n'
    + '          renders a pulsing badge over silence again.');
} else {
  ok('lib/pi.ts still filters live items through liveBroadcastIsOver');
}
// It must be applied to BOTH sources: the RSS parser and PI's own roster. A
// `pi-only` row survives an unreadable feed by design, so dropping the roster
// half would leave exactly the reported failure reachable whenever RSS 503s.
const calls = (pi.match(/liveBroadcastIsOver\(/g) ?? []).length;
if (calls < 2) {
  fail(`liveBroadcastIsOver is called ${calls}x in lib/pi.ts — it must filter the\n`
    + '          RSS parser AND PI\'s global roster, or a stale row survives an\n'
    + '          unreadable feed.');
} else {
  ok('both the RSS parser and PI\'s roster are filtered');
}
// `end` has to actually be read, or every vector above tests a field nothing
// ever populates.
if (!/readAttr\(attrs, 'end'\)/.test(pi)) {
  fail("lib/pi.ts no longer reads the `end` attribute — the grace is then measured\n"
    + '          from a field nothing populates and only the 24h guess remains.');
} else {
  ok('the `end` attribute is parsed off the liveItem');
}
// The status has to reach the function, or every live item is judged as if it
// were `pending` and the grace is unreachable.
const withStatus = (pi.match(/liveBroadcastIsOver\(\{\s*status/g) ?? []).length;
if (withStatus < 2) {
  fail(`lib/pi.ts passes \`status\` to liveBroadcastIsOver at ${withStatus} of its\n`
    + '          call sites — without it an on-air show is judged as a schedule and\n'
    + '          dropped at its scheduled end again.');
} else {
  ok('`status` is passed through at both call sites');
}

console.log(failures
  ? `\n${failures} live-over check(s) FAILED.\n`
  : '\nAll live-over checks passed.\n');
process.exit(failures ? 1 : 0);
