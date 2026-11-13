# Catch up to live

**Date:** 2026-11-12

## Intent

During Homegrown Hits 158 Chad could not tell whether the player was caught up, so he refreshed the
page to make sure. The refresh played a few seconds he had already heard. The `● LIVE · streaming now`
line is fixed text: it reads the same at 0 s and at 60 s behind, so a refresh was the only way to
check, and the only way to catch up that he knew of.

The listener must see when the player is behind the live edge, by how much, and catch up with one
press.

## What was measured (2026-11-12, Homegrown Hits 158)

- The live MP3 (`stream.bowlafterbowl.com`, Icecast behind nginx, 128 kbps) sends about 54 KB at once
  on connect, then 16 KB/s. A new connection starts 3 to 4 s behind the server. That burst is what a
  refresh plays again.
- Chrome holds a steady 2.3 s ahead of the play head on that stream.
- A 12 s network gap, made by a local proxy that held the bytes and then let them through, left
  playback 10.2 s behind. It stayed 10.2 s behind for the next 30 s. A live item plays at 1×, so
  nothing in the player catches up. `buffered.end - currentTime` stayed under 2 s the whole time, so
  the buffer does NOT show the delay; only the clock does.
- Pause, then play, already reconnects at the live edge (`pausedLive` → `reloadNonce`,
  `components/player.tsx`). Nothing on screen says so.

## Goals

- While a live item plays and the player is 5 s or more behind where a fresh connect would start,
  both players show `N s behind` and a `GO LIVE` button in place of `streaming now`.
- `GO LIVE` reconnects at the live edge, the same way pause then play does, and the line goes back
  to `streaming now`.
- Works for every live source the player has: an RSS `<podcast:liveItem>` MP3 on the `<audio>`, an
  HLS stream on hls.js, and HLS played natively by Safari. Nostr streams use the same player.

## Non-goals

- No automatic catch-up. The HLS config comment in `components/player.tsx` records the choice that
  "a seek is audible and a few extra seconds behind live is not"; a jump the listener did not ask
  for, in the middle of a song, is that seek.
- No claim about latency to the broadcaster's microphone. The number is time behind a fresh
  connect, which is the best a reconnect can do.
- No new setting.

## Anti-goals

- **A `GO LIVE` that replays audio.** Shown at 0 to 4 s behind, a press reconnects into the 3 to 4 s
  burst and repeats what was just heard, which is the complaint. Hence the 5 s threshold.
- **A `<Player>` render per tick.** The shown value changes only when the rounded number of seconds
  changes, and it is 0 (no change) while the player is on time.
- **A readout while paused.** A paused live item reconnects on play anyway; counting the pause as
  "behind" would show a number nobody can act on.

## Approaches

1. **Readout and button only when behind (picked by Chad).** Answers "am I caught up" and offers the
   press only when it helps.
2. Always-visible `GO LIVE`. Simpler, but it does not answer the question, and a press when current
   replays the burst.
3. Automatic catch-up. No control, but an unrequested audible jump; rejected for the reason in
   Non-goals.

## Design

- **Measure by the clock.** At the first `playing` of each source, record the wall clock and
  `currentTime`. Behind = wall seconds since then minus media seconds played since then. If it goes
  below 0 (hls.js moved the play head forward), re-anchor there. A pure function in an import-free
  `lib/` leaf holds this, so the e2e and the player share one rule.
- **Sample** on the element's existing once-a-second `timeupdate` tick, the one that already calls
  `setPosition`. A stalled element fires no `timeupdate`, but the existing `⋯ buffering` line covers
  the stall, and the delay shows on the first tick after it. Store the rounded value in state only
  when it changes.
- **Show** one small component, used by the mini-bar and both live rows of the full-screen player:
  `● LIVE  streaming now`, or `● LIVE  12 s behind  [⏭ GO LIVE]`. The button meets the 24 × 24 px
  touch-target minimum.
- **GO LIVE** bumps `reloadNonce`, the path pause-then-play and the stall recovery already use. The
  source effect resets the anchor.
- **Test** with a new `e2e:livecatchup` script: a local MP3 stream behind a proxy that can hold its
  bytes, an intercepted `/api/feed` and `/api/live-status` that make one item live with that
  enclosure, a forced 12 s gap, the readout and button checked, a press, and a new connection with
  the line back to `streaming now`. Then the mobile layout at 390 px with device emulation.

## Left to the builder

- Exact wording and placement inside the existing row, within `docs/ui.md`'s rules.
- Whether hls.js should seek to `liveSyncPosition` instead of a full reconnect. Default: reconnect,
  one path for every source.
