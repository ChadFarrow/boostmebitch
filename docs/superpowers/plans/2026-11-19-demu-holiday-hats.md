# DeMu Holiday Hats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The /demu title's emu wears the tail feathers and a pilgrim hat in Thanksgiving week and a Santa hat from 1 to 26 Dec, by the visitor's calendar.

**Architecture:** A pure, import-free `lib/demu-holiday.ts` decides the costume from a `Date` and the `?holiday=` override. `HolidayEmuIcon` in `components/icons.tsx` draws the costume around the shared emu paths. `components/demu-page.tsx` reads the costume through `useSyncExternalStore` with a `null` server snapshot, so the prerendered plain emu hydrates cleanly and the costume swaps in without moving the title.

**Tech Stack:** Next.js App Router, React, Tailwind, inline SVG; `node --experimental-strip-types` check scripts; CDP e2e on `scripts/cdp.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-19-demu-holiday-hats-design.md`

## Global Constraints

- Thanksgiving window: Monday 00:00 to the next Monday 00:00 (local) around the FOURTH Thursday of November; it wins over Christmas on 1 Dec.
- Christmas window: 1 Dec 00:00 to 27 Dec 00:00 (local).
- `?holiday=thanksgiving|christmas` forces that costume; `?holiday=none` forces the plain emu; any other value is ignored.
- `lib/demu-holiday.ts` has NO imports (CLAUDE.md, `demu*.ts`).
- `EmuIcon`'s SVG output does not change by one byte.
- The costume keeps the emu's `1em` box: the title's height and the word's x do not change.
- Thanksgiving = feathers + pilgrim hat, NO wattle (Chad's note). Christmas = Santa hat, no feathers.

## Review Focus

1. A hydration mismatch on a holiday date (the server prerenders the plain emu) — expect no React hydration warning in the console. Pinned in Task 2's e2e.
2. The title or the list jumps when the costume appears — expect the h1's box and the word's left edge identical with and without a costume. Task 2's e2e.
3. A dark hat or a white brim on a page of the same colour — expect a visible faint edge in both themes. Task 2's e2e takes both-theme screenshots for an eye check.
4. A New York visitor at 23:30 on Sunday 29 Nov, which is Monday in UTC — expect the turkey still. Task 1 vector.
5. A junk override (`?holiday=easter`) — expect the calendar to decide. Task 1 vector.

---

### Task 1: The calendar — `lib/demu-holiday.ts`, pinned by `check:demu`

**Files:**
- Create: `lib/demu-holiday.ts`
- Modify: `scripts/check-demu.mjs` (a new section before the import-free block; add the path to that block's list)

**Interfaces:**
- Produces:
  - `export type DemuHoliday = 'thanksgiving' | 'christmas'`
  - `export function thanksgivingDay(year: number): number` — day of November
  - `export function demuHolidayOn(at: Date): DemuHoliday | null`
  - `export function demuHolidayFor(at: Date, param: string | null | undefined): DemuHoliday | null`

- [ ] **Step 1: Write the vectors** — `holidayVectors`, replayed with `replayVectors`, `t(y, m, d, h?, min?)` = local seconds as the file already builds them (TZ is New York). `kind: 'tday'` calls `thanksgivingDay`; `kind: 'on'` calls `demuHolidayOn(new Date(sec*1000))`; `kind: 'for'` calls `demuHolidayFor(date, param)`. `naive()` = the LAST Thursday of November, the same window rule, and `param` ignored.
  - tday 2026 → 26; 2025 → 27; 2024 → 28 (alsoNaive); 2029 → 22 (five Thursdays: proves); 2030 → 28 (alsoNaive)
  - on 2026-11-22 23:59 → null; 2026-11-23 00:00 → thanksgiving; 2026-11-29 23:30 → thanksgiving; `Date.UTC(2026,10,30,4,30)` (Sunday 23:30 in New York) → thanksgiving; 2026-11-30 00:00 → null; 2026-12-01 → christmas; 2026-12-26 23:59 → christmas; 2026-12-27 00:00 → null; 2026-07-04 → null
  - on 2024-12-01 12:00 → thanksgiving (the Sunday after a 28 Nov Thanksgiving); 2024-12-02 → christmas
  - on 2029-11-20 → thanksgiving (the 22nd's week; naive puts it a week late: proves); 2029-11-27 → null (naive: thanksgiving)
  - for (2026-07-04, 'thanksgiving') → thanksgiving; (2026-07-04, 'christmas') → christmas; (2026-11-24, 'none') → null; (2026-11-24, 'easter') → thanksgiving; (2026-11-24, null) → thanksgiving
  - Every kind has at least one vector that proves (the file's existing family check pattern).

- [ ] **Step 2: Run `npm run check:demu`** — Expected: FAIL, `lib/demu-holiday.ts` not found.

- [ ] **Step 3: Implement `lib/demu-holiday.ts`** — local `Date` constructors only (`new Date(y, 10, day)` rolls into December by itself). Thanksgiving is tested first. `demuHolidayFor`: `'none'` → `null`; a `DemuHoliday` → itself; anything else → `demuHolidayOn(at)`. A header comment says why the fourth Thursday, why local time, and that Thanksgiving keeps 1 Dec.

- [ ] **Step 4: Run `npm run check:demu`** — Expected: `all ok`, with `lib/demu-holiday.ts is import-free`.

- [ ] **Step 5: Commit** `feat(demu): which holiday hat the emu wears, by the visitor's calendar`

### Task 2: The drawing and the title — `HolidayEmuIcon`, `/demu`, e2e, docs

**Files:**
- Modify: `components/icons.tsx` (shared `EMU_HEAD`/`EMU_BAND` constants used by `EmuIcon` and the new icon)
- Modify: `components/demu-page.tsx` (the h1, around line 190)
- Create: `scripts/e2e-demu-holiday.mjs`; Modify: `package.json` (`"e2e:demuholiday"`)
- Modify: `scripts/e2e-search-type-icons.mjs` (`go('/demu')` → `go('/demu?holiday=none')`, with a comment)
- Modify: `docs/ui.md` (a bullet in "The DeMu page"; the search-type paragraph's "/demu's title … draw the same component" gets "outside a holiday")

**Interfaces:**
- Consumes: `DemuHoliday`, `demuHolidayFor` (Task 1)
- Produces: `export function HolidayEmuIcon({ holiday, className }: { holiday: DemuHoliday; className?: string })` — `viewBox="0 0 24 24"`, `overflow-visible`, `data-holiday={holiday}`, same `aria-hidden` and `fill-current` as `EmuIcon`.

- [ ] **Step 1: Write `scripts/e2e-demu-holiday.mjs`** (the `e2e-search-type-icons.mjs` shape: `launchChrome`, `checker`, phone emulation 390×844 `mobile: true`, then 320). Checks:
  - `/demu?holiday=none`: `[data-demu-title] svg` has no `data-holiday`; record the h1 rect and the text node's left x.
  - `/demu?holiday=thanksgiving`: `svg[data-holiday="thanksgiving"]` within 5 s; it has the feathers and the hat and no wattle (`[data-part="feathers"]`, `[data-part="pilgrim"]`, none `[data-part="wattle"]`); the svg box is 1em × 1em; the h1 rect and the word's x equal the plain ones (±0.5 px); no horizontal overflow at 390 and 320.
  - `/demu?holiday=christmas`: `[data-part="santa"]`, no feathers; same box checks.
  - `/demu?holiday=easter` under a faked date of 24 Nov 2026 12:00 (`Page.addScriptToEvaluateOnNewDocument` replacing `Date` so `new Date()`/`Date.now()` start there) → thanksgiving; the same fake with no param → thanksgiving; a fake of 4 Jul 2026 → plain.
  - The console shows no hydration warning (`Runtime.consoleAPICalled` / `Runtime.exceptionThrown` text matching `/hydrat/i`).
  - Screenshots of the title in dark and light (`SHOT_DIR`).

- [ ] **Step 2: Run it** against `npm run dev` — Expected: FAIL (no `data-holiday`).

- [ ] **Step 3: Implement `HolidayEmuIcon`** from the approved drafts (`demu-turkey-picker.html` on the claude.ai page): feathers = 9 ellipses, pivot (12.5, 18), length 16, rx 2.8, spread 170°, colours rust `#c8432b` / orange `#ea8a2f` / brown `#94602f`; the emu's page-coloured outline (`fill-ink stroke-ink`, width 2.2, band 4.2) only when feathers are behind it; the pilgrim and Santa groups as drafted, each with its `fill-ink stroke-ink` outline and a `stroke-bone/35` 0.35 edge on the dark hat and the white fur. Each layer carries its `data-part`.

- [ ] **Step 4: Wire the title** — `const holiday = useSyncExternalStore(noop, () => demuHolidayFor(new Date(), new URLSearchParams(location.search).get('holiday')), () => null)`; render `HolidayEmuIcon` when non-null, else the unchanged `EmuIcon`, both with `w-[1em] h-[1em] text-bolt`.

- [ ] **Step 5: Run `npm run e2e:demuholiday` and `npm run e2e:typeicons`** — Expected: all pass. Look at the screenshots.

- [ ] **Step 6: Docs** — the `docs/ui.md` bullet: what each costume is, the windows, the override, why the 1em box with `overflow: visible`, why the small emus stay plain, and the verification commands.

- [ ] **Step 7: Run `npm run typecheck && npm run lint && npm run check`** — Expected: no errors; `check` all green.

- [ ] **Step 8: Commit** `feat(demu): the emu wears a pilgrim hat for Thanksgiving and a Santa hat for Christmas`

### After the tasks

- Stop the dev server, `rm -rf .next`, `npm run build` — Expected: success.
- Push the branch, open the PR (body: what the browser test verified, what it did not — a real iPhone).
