// Pins `liveBroadcastIsOver` (lib/util.ts) — whether a `<podcast:liveItem>`
// still marked `live` is actually still on air.
//
// THE FAILURE THIS WAS WRITTEN AGAINST, measured 2026-09-06 on the live site.
// `/live` showed "Behind the Sch3m3s — S02E49: It's Alive!!" with a pulsing
// `● LIVE` badge and a working PLAY button. The feed really did say so:
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
// naive() is the shipped behaviour: trust `status`, full stop. Every vector is
// replayed against it, and one both agree on is reported as proving nothing.
//
// FIXTURE PROVENANCE. The `end`-bearing vectors are the real attribute values
// from three feeds read on 2026-09-06 — behindthesch3m3s.com (the failure),
// music.behindthesch3m3s.com/Sat_Skirmish (3.5 h broadcasts, which is why the
// no-`end` ceiling cannot be the Nostr side's 2 h), and feed.homegrownhits.xyz
// (a `pending` item whose `end` is in the future).
import { liveBroadcastIsOver, MAX_UNBOUNDED_LIVE_SECS } from '../lib/util.ts';

let failures = 0;
const fail = (m) => { console.error('  ✗ ' + m); failures++; };
const ok = (m) => console.log('  ok    ' + m);

// ── The wrong version: the status attribute is the whole answer ────────────
function naive() { return false; }

const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const NOW = sec('2026-09-06T15:00:00.000Z');
const HOUR = 3600;

const VECTORS = [
  {
    name: 'THE FAILURE: status="live" whose declared end was five days ago',
    args: [{ status: 'live', startTime: sec('2026-09-01T02:00:00.000Z'), endTime: sec('2026-09-01T05:30:00.000Z') }, NOW],
    expect: true,
  },
  {
    name: 'a broadcast still inside its declared window is ON AIR',
    args: [{ status: 'live', startTime: NOW - HOUR, endTime: NOW + 2 * HOUR }, NOW],
    expect: false,
    alsoNaive: true,
  },
  {
    name: 'a 3.5h Satellite Skirmish broadcast, one minute from its end, is ON AIR',
    args: [{ status: 'live', startTime: NOW - 3.5 * HOUR, endTime: NOW + 60 }, NOW],
    // The must-still-work half: over-blocking is a regression too, and this is
    // the shape that would break first if the ceiling were applied over `end`.
    expect: false,
    alsoNaive: true,
  },
  {
    name: 'end exactly now is not yet past',
    args: [{ status: 'live', startTime: NOW - HOUR, endTime: NOW }, NOW],
    expect: false,
    alsoNaive: true,
  },
  {
    name: 'no end, started 25h ago → over on the ceiling',
    args: [{ status: 'live', startTime: NOW - MAX_UNBOUNDED_LIVE_SECS - HOUR }, NOW],
    expect: true,
  },
  {
    name: 'no end, started 12h ago → still on air (a podcast is not a Nostr stream)',
    args: [{ status: 'live', startTime: NOW - 12 * HOUR }, NOW],
    expect: false,
    alsoNaive: true,
  },
  {
    name: 'the ceiling is not the Nostr side’s 2h — a 3h broadcast survives it',
    args: [{ status: 'live', startTime: NOW - 3 * HOUR }, NOW],
    expect: false,
    alsoNaive: true,
  },
  {
    name: 'THE SECOND FAILURE: a PENDING window that closed 18 months ago',
    // Before The Sch3m3s, read 2026-09-06: scheduled for 2025-03-10, never
    // aired, never cleared, and sitting at the top of Upcoming under a start
    // date in the past. This vector is why the rule ignores `status`.
    args: [{ status: 'pending', startTime: sec('2025-03-10T01:00:00.000Z'), endTime: sec('2025-03-10T04:30:00.000Z') }, NOW],
    expect: true,
  },
  {
    name: 'a PENDING host running an hour late is still coming',
    // The case the old "pending is never over" rule existed to protect, and it
    // still holds: lateness is measured against `end`, which has not passed.
    args: [{ status: 'pending', startTime: NOW - HOUR, endTime: NOW + 2 * HOUR }, NOW],
    expect: false,
    alsoNaive: true,
  },
  {
    name: 'a PENDING item with no end, an hour past its start, is still coming',
    args: [{ status: 'pending', startTime: NOW - HOUR }, NOW],
    expect: false,
    alsoNaive: true,
  },
  {
    name: 'a PENDING item scheduled days out is not over',
    args: [{ status: 'pending', startTime: sec('2026-09-10T19:00:59.000Z'), endTime: sec('2026-09-11T12:00:00.000Z') }, NOW],
    expect: false,
    alsoNaive: true,
  },
  {
    name: 'neither end nor start is not evidence of anything',
    args: [{ status: 'live' }, NOW],
    expect: false,
    alsoNaive: true,
  },
  {
    name: 'a malformed end is ignored rather than treated as expired',
    args: [{ status: 'live', startTime: NOW - HOUR, endTime: NaN }, NOW],
    expect: false,
    alsoNaive: true,
  },
  {
    name: 'end wins over a start that would trip the ceiling',
    // A very long broadcast that DECLARES it is still running is on air. The
    // specific field beats the fallback, or the fallback silently overrides the
    // publisher.
    args: [{ status: 'live', startTime: NOW - 40 * HOUR, endTime: NOW + HOUR }, NOW],
    expect: false,
    alsoNaive: true,
  },
];

for (const v of VECTORS) {
  const got = liveBroadcastIsOver(...v.args);
  if (got !== v.expect) { fail(`${v.name} — expected ${v.expect}, got ${got}`); continue; }
  const naiveAgrees = naive(...v.args) === v.expect;
  if (naiveAgrees && !v.alsoNaive) {
    fail(`${v.name} — naive() passes it too, so this vector proves nothing.`);
  } else if (!naiveAgrees && v.alsoNaive) {
    fail(`${v.name} — marked alsoNaive but naive() FAILS it. The mark is wrong.`);
  } else {
    ok(v.name + (v.alsoNaive ? '  (must-still-work)' : '  (naive() fails it)'));
  }
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
  fail("lib/pi.ts no longer reads the `end` attribute — the authoritative half\n"
    + '          of the rule is then dead and only the 24h guess remains.');
} else {
  ok('the `end` attribute is parsed off the liveItem');
}

console.log(failures
  ? `\n${failures} live-over check(s) FAILED.\n`
  : '\nAll live-over checks passed.\n');
process.exit(failures ? 1 : 0);
