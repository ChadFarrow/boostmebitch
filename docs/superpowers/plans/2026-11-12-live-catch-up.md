# Catch up to live — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a live item plays 5 s or more behind where a fresh connect would start, both players show `N s behind` and a `⏭ GO LIVE` button that reconnects at the live edge.

**Architecture:** A pure, import-free `lib/live-lag.ts` turns (anchor, wall clock, `currentTime`) into seconds behind. `<Player>` anchors at the first `playing` of each source, samples on its existing once-a-second `timeupdate` tick, keeps the shown value in state, and reconnects through the existing `reloadNonce`. One `<LiveEdge>` component draws the row in the mini-bar and in both live rows of `<FullscreenPlayer>`.

**Tech Stack:** Next.js / React / TypeScript, zustand store, CDP harness `scripts/cdp.mjs`, `ffmpeg` for the test stream.

**Spec:** `docs/superpowers/specs/2026-11-12-live-catch-up-design.md`

## Global Constraints

- Threshold `LIVE_BEHIND_MIN_SEC = 5`; below it the row reads `streaming now`.
- Copy: `streaming now`, `N s behind`, `⏭ GO LIVE`.
- No automatic catch-up; no new setting; no change under `lib/v4v/` (a re-source already bills nothing for that tick, `docs/streaming.md`).
- The row shows the delay only while `isPlaying`.
- Touch target of the button: at least 24 × 24 CSS px (WCAG 2.5.8), measured at 390 × 844 with `Emulation.setDeviceMetricsOverride { mobile: true }`.
- No `check:*` script (those are for losses a user cannot undo); the test is `npm run e2e:livecatchup`.
- `lib/live-lag.ts` imports nothing, so the e2e can load it under `--experimental-strip-types`.

## Review Focus

1. **hls.js moves the play head forward after `playing`** — behind must not go negative; the anchor moves there, and a later gap still counts in full. Pinned by unit vector "ran ahead, then a gap".
2. **A pause on a live item** — no delay shown while paused, and play reconnects as today. Pinned by e2e step "pause hides the delay".
3. **The mini-bar at 390 px** — the extra button must not push the transport off screen or overflow the page. Pinned by e2e mobile step.
4. **The press inside the mini-bar** — the bar opens the full-screen player on click; the button must not. Pinned by e2e step "GO LIVE does not open the full-screen player".
5. **A second gap after GO LIVE** — the new source starts with no anchor and counts from its own `playing`. Pinned by e2e step "a second gap after GO LIVE".

---

### Task 1: The delay rule

**Files:**
- Create: `lib/live-lag.ts`
- Create: `scripts/e2e-live-catch-up.mjs` (unit part only in this task)
- Modify: `package.json` (`"e2e:livecatchup": "node --experimental-strip-types scripts/e2e-live-catch-up.mjs"`)

**Interfaces:**
- Produces:
  - `export interface LiveAnchor { wallSec: number; mediaSec: number }`
  - `export const LIVE_BEHIND_MIN_SEC = 5`
  - `export function liveLag(anchor: LiveAnchor, wallSec: number, mediaSec: number): { behindSec: number; anchor: LiveAnchor }` — behind = (wall − anchor.wall) − (media − anchor.media); below 0 → `behindSec: 0` and `anchor: { wallSec, mediaSec }`.
  - `export function behindToShow(behindSec: number): number` — `0` under `LIVE_BEHIND_MIN_SEC`, else `Math.round(behindSec)`.

- [ ] **Step 1: Write the unit vectors** at the top of `scripts/e2e-live-catch-up.mjs`, run before anything needs the app; `UNIT_ONLY=1` exits after them.

```js
eq('on time', liveLag({ wallSec: 0, mediaSec: 100 }, 10, 110).behindSec, 0);
eq('a 12 s gap', liveLag({ wallSec: 0, mediaSec: 100 }, 40, 128).behindSec, 12);
const ahead = liveLag({ wallSec: 0, mediaSec: 100 }, 10, 113);
eq('ran ahead: not negative', ahead.behindSec, 0);
eq('ran ahead: re-anchored', ahead.anchor, { wallSec: 10, mediaSec: 113 });
eq('ran ahead, then a gap counts in full', liveLag(ahead.anchor, 30, 125).behindSec, 8);
eq('4.9 s shows nothing', behindToShow(4.9), 0);
eq('5 s shows', behindToShow(5), 5);
eq('10.2 s shows 10', behindToShow(10.2), 10);
eq('10.6 s shows 11', behindToShow(10.6), 11);
```

- [ ] **Step 2: Run** `UNIT_ONLY=1 npm run e2e:livecatchup` — expected FAIL: `ERR_MODULE_NOT_FOUND` for `lib/live-lag.ts`.
- [ ] **Step 3: Implement** `lib/live-lag.ts` per the Interfaces block, with a header comment carrying the 2026-11-12 measurement (12 s gap → 10.2 s behind, buffer under 2 s, so the clock and not `buffered` is the witness).
- [ ] **Step 4: Run** `UNIT_ONLY=1 npm run e2e:livecatchup` — expected: all ten vectors pass, exit 0.
- [ ] **Step 5: Commit** `lib/live-lag.ts`, the script, `package.json`.

### Task 2: The readout and GO LIVE in both players

**Files:**
- Create: `components/live-edge.tsx`
- Modify: `components/player.tsx` (source effect start ~L500; `onPlaying` of `<video>` ~L1430 and `<audio>` ~L1583; the per-second tick in both `onTimeUpdate`; the mini-bar live row ~L1681; the `<FullscreenPlayer>` props)
- Modify: `components/fullscreen-player.tsx` (props; live rows ~L1252 and ~L1315)
- Modify: `scripts/e2e-live-catch-up.mjs` (app part)
- Modify: `docs/ui.md` (new `### Catch up to live` after the stall paragraph, ~L1155)

**Interfaces:**
- Consumes: `liveLag`, `behindToShow`, `LiveAnchor` from Task 1.
- Produces:
  - `export function LiveEdge({ behindSec, onGoLive, compact }: { behindSec: number; onGoLive: () => void; compact?: boolean })` — returns the row's children: `<LiveBadge status="live" />`, then `streaming now`, or `{behindSec} s behind` and a `<button type="button" data-go-live>` reading `⏭ GO LIVE` whose click calls `stopPropagation()` then `onGoLive()`. Text `text-[10px]` when `compact`, else `text-xs`. Root carries `data-live-edge`.
  - `<FullscreenPlayer>` gains `liveBehindSec: number` and `onGoLive: () => void`.

- [ ] **Step 1: Write the app scenarios** in the e2e, after the unit part. Setup: `requireApp(APP)`; an `ffmpeg` 60 s 128 kbps stereo sine MP3 in a temp dir; a local server pacing it at 16 000 B/s in a loop, with `hold()`/`release()` (bytes delayed, not dropped) and a connection counter; CDP `Fetch` at the Response stage rewriting `/api/feed` (first episode → `guid: 'e2e-live'`, `liveStatus: 'live'`, `enclosureUrl` = the local stream, no `liveValue`) and answering `/api/live-status` with that guid live; open `/?podcast=ac746d09-7c3b-5bcd-b28a-f12d6456ca8f&episode=e2e-live` and start play. Assertions:
  - on time after 8 s: `[data-live-edge]` reads `streaming now`, no `[data-go-live]`.
  - after `hold()` 12 s and `release()` + 4 s: text matches `/(\d+) s behind/` with N in 9..14; `[data-go-live]` present.
  - GO LIVE does not open the full-screen player; connection count +1; within 6 s the row reads `streaming now` and the element plays.
  - a second gap after GO LIVE shows the delay again, in the full-screen player too, and its button reconnects.
  - pause hides the delay; play reconnects (count +1).
  - mobile 390 × 844: `scrollWidth <= clientWidth`; the mini-bar button box ≥ 24 × 24 and inside the viewport; the transport play/pause button still inside the viewport.
- [ ] **Step 2: Run** `npm run e2e:livecatchup` against `npm run dev` — expected FAIL at "no `[data-live-edge]`".
- [ ] **Step 3: Implement** `components/live-edge.tsx` per Interfaces.
- [ ] **Step 4: Wire `<Player>`:** `liveAnchor = useRef<LiveAnchor | null>(null)` and `const [liveBehindSec, setLiveBehindSec] = useState(0)`; the source effect sets the ref to null and the state to 0; each element's `onPlaying` (active element only) anchors when the ref is null and `isLiveRef.current`; one helper `sampleLiveLag(el)` called in both per-second tick branches updates the ref and sets state only when `behindToShow` changed; `goLive = () => setReloadNonce((n) => n + 1)`; the mini-bar row and `<FullscreenPlayer>` get `isPlaying ? liveBehindSec : 0` and `goLive`.
- [ ] **Step 5: Wire `<FullscreenPlayer>`:** both live rows render `<LiveEdge behindSec={liveBehindSec} onGoLive={onGoLive} />`.
- [ ] **Step 6: Run** `npm run e2e:livecatchup`, `npm run typecheck`, `npm run lint` — expected: all pass, zero lint errors.
- [ ] **Step 7: Write** the `docs/ui.md` section: why the clock (the measurement), why 5 s (the burst), why no auto catch-up (the HLS config's audible-seek rule), the pause rule, and `npm run e2e:livecatchup` as the pin.
- [ ] **Step 8: Commit** the components, the e2e, the docs, the spec and this plan.
