// `npm run e2e:livecatchup` — the live player's "N s behind / GO LIVE" row.
//
// THE REPORT, 2026-11-12, Homegrown Hits 158: the listener could not tell
// whether the player was caught up, so they refreshed the page to make sure,
// and the refresh played a few seconds they had already heard. The row read
// `● LIVE streaming now` whatever the delay, so a refresh was the only check.
//
// What was measured that day, and what this script replays:
// - The Icecast MP3 sends ~54 KB at once on connect, then 16 KB/s (128 kbps):
//   a fresh connect starts 3-4 s behind the server. That burst is what a
//   refresh plays again, and why the row stays quiet under 5 s.
// - A 12 s network gap (a proxy holding the bytes, then letting them through)
//   left playback 10.2 s behind, and it stayed there: a live item plays at 1×,
//   so nothing catches up. `buffered.end - currentTime` stayed under 2 s the
//   whole time — the buffer does NOT show the delay, only the clock does.
//
// Part 1 needs nothing running: the rule in lib/live-lag.ts against fixed
// vectors. `UNIT_ONLY=1` stops there. Part 2 drives the real app against a
// local MP3 stream this script paces itself, through a hold it controls.
import { liveLag, behindToShow, LIVE_BEHIND_MIN_SEC } from '../lib/live-lag.ts';
import { checker, exit } from './cdp.mjs';

const t = checker();

console.log('Part 1 — the delay rule (lib/live-lag.ts)');
t.equal('the threshold is 5 s', LIVE_BEHIND_MIN_SEC, 5);
t.equal('on time', liveLag({ wallSec: 0, mediaSec: 100 }, 10, 110).behindSec, 0);
t.equal('a 12 s gap', liveLag({ wallSec: 0, mediaSec: 100 }, 40, 128).behindSec, 12);
const ahead = liveLag({ wallSec: 0, mediaSec: 100 }, 10, 113);
t.equal('ran ahead: not negative', ahead.behindSec, 0);
t.equal('ran ahead: re-anchored where the play head is', ahead.anchor, { wallSec: 10, mediaSec: 113 });
t.equal('ran ahead, then a gap counts in full', liveLag(ahead.anchor, 30, 125).behindSec, 8);
const kept = liveLag({ wallSec: 0, mediaSec: 100 }, 40, 128);
t.equal('behind: the anchor is kept', kept.anchor, { wallSec: 0, mediaSec: 100 });
t.equal('4.9 s shows nothing', behindToShow(4.9), 0);
t.equal('5 s shows', behindToShow(5), 5);
t.equal('10.2 s shows 10', behindToShow(10.2), 10);
t.equal('10.6 s shows 11', behindToShow(10.6), 11);

if (process.env.UNIT_ONLY) {
  console.log(t.fails ? `\n${t.fails} check(s) FAILED.` : '\nAll unit checks passed.');
  await exit(t.fails ? 1 : 0);
}
