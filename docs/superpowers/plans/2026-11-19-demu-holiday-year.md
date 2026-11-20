# The DeMu emu, all year — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The /demu title's emu wears one of 11 looks every day of the year, by the visitor's calendar.

**Architecture:** An ordered table of looks with each one's last day in the import-free `lib/demu-holiday.ts`; today's look is the first whose last day has not passed, and 27–31 Dec wrap to New Year's. The art is a table of `{ back, front, gap }` SVG fragments in `components/demu-costumes.tsx`, drawn by `HolidayEmuIcon` with the masks it already has.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript strict, inline SVG; checks are `node` scripts (`check:demu`) and CDP e2e (`e2e:demuholiday` on `scripts/cdp.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-19-demu-holiday-year-design.md`

## Global Constraints

- `lib/demu-holiday.ts` stays import-free (`check:demu` scans it).
- The 11 names, in year order: `newyear`, `valentines`, `stpatricks`, `easter`, `pizzaday`, `july4`, `summer`, `podcastday`, `halloween`, `thanksgiving`, `christmas`.
- Last days: 1 Jan, 14 Feb, 17 Mar, Easter Sunday (Gregorian), 22 May, 4 Jul, Labor Day (first Monday of Sep), 30 Sep, 31 Oct, Thanksgiving (fourth Thursday of Nov), 26 Dec. New Year's runs 27 Dec through 1 Jan.
- Local time decides. A look shows from 00:00 the day after the previous look's last day.
- Gaps are SVG masks; nothing is painted in `--ink`. Costume colours are fixed hex; the faint edge is `className="stroke-bone/35" strokeWidth="0.35"`.
- The art is the drafts Chad picked, shape for shape (scratchpad `gen/looks.mjs`, the `v` he picked per look).

## Review Focus

- 27–31 Dec: New Year's, not a plain emu and not Christmas — vectors at 27 Dec 00:00 and 31 Dec 23:59.
- The last minute of each own day (23:59 in New York, already the next day in UTC) still shows that look — one vector per look.
- Easter in a year when it is early (22 Mar 2285) or late (25 Apr 2038) keeps St. Patrick's before it and Pizza Day after it.
- The sunglasses cover the eye on purpose: the e2e's open-eye check must expect the lens there, not skip the look silently.
- A junk `?holiday=` (`Easter`, `birthday`) leaves the calendar in charge.

---

### Task 1: The year of looks in `lib/demu-holiday.ts`

**Files:**
- Modify: `lib/demu-holiday.ts`
- Test: `scripts/check-demu.mjs` (the holiday section)

**Interfaces:**
- Produces: `DEMU_HOLIDAYS: readonly DemuHoliday[]`; `type DemuHoliday`; `easterSunday(year: number): Date` (local midnight); `laborDay(year: number): number` (day of September); `thanksgivingDay(year)` unchanged; `demuHolidayOn(at: Date): DemuHoliday`; `demuHolidayFor(at: Date, param: string | null | undefined): DemuHoliday | null`.

- [ ] **Step 1: Write the failing vectors** — kinds `easter` (`easterSunday(y).toDateString()`: 2026 `Sun Apr 05 2026`, 2027 `Sun Mar 28 2027`, 2038 `Sun Apr 25 2038`, 2285 `Sun Mar 22 2285`, 2024 `Sun Mar 31 2024`), `labor` (2025 → 1, 2026 → 7, 2027 → 6), `on` (each look's last day at 23:59 → that look; the next day 00:00 → the next look; 27 Dec 2026 00:00 and 31 Dec 23:59 → `newyear`; 1 Jan 2027 23:59 → `newyear`; 2 Jan 2027 00:00 → `valentines`; 29 Mar 2027 → `pizzaday`; 4 Jul 2026 → `july4`; the existing Thanksgiving/Christmas vectors kept), `for` (each name forces itself in July; `none` → null; `Easter` and `birthday` → the calendar). `naiveOn` = the same table with no year wrap (null after 26 Dec), Easter fixed at 5 Apr, Labor Day `1 + ((1 - w) % 7)`, the last Thursday, and UTC fields. Every kind keeps at least one vector `naive()` fails.
- [ ] **Step 2: Run** `npm run check:demu` — expect failures (`easterSunday` is not exported).
- [ ] **Step 3: Implement** the table and the three functions; `demuHolidayOn` walks the table for `at.getFullYear()` and returns the first look with `at < new Date(year, month, day + 1)`, else `newyear`. Easter by the anonymous Gregorian algorithm (Meeus/Jones/Butcher).
- [ ] **Step 4: Run** `npm run check:demu` and `npm run typecheck` — expect all ok. Typecheck fails in `components/icons.tsx` until Task 2 if the type widens there; run it after Task 2 if so.
- [ ] **Step 5: Commit** `feat(demu): the emu wears a look all year — the schedule`.

### Task 2: The nine new costumes

**Files:**
- Create: `components/demu-costumes.tsx`
- Modify: `components/icons.tsx` (export `EMU_HEAD`, `EMU_BAND`, `EmuShapes`; move `HolidayEmuIcon` and the two live costumes out), `components/demu-page.tsx` (import path, comment)
- Test: `scripts/e2e-demu-holiday.mjs`

**Interfaces:**
- Consumes: `DemuHoliday`, `DEMU_HOLIDAYS` from Task 1.
- Produces: `HolidayEmuIcon({ holiday, className })` from `components/demu-costumes.tsx`; its SVG carries `data-holiday`, `<g data-part="back">` when the look has one, `<g data-part="emu">`, `<g data-part="front">` when it has one.

- [ ] **Step 1: Update the e2e** to loop over `DEMU_HOLIDAYS` at 390 and 320 px: worn, `back`/`front` present as the table says, masks = 2 with a back else 1, the eye open (summer: the eye pixel near the lens `#1f1d1c`), the same emu, bolt and 1em, box and word unchanged, no overflow. Calendar: 24 Nov → `thanksgiving`, 27 Nov → `christmas`, 27 Dec 2026 → `newyear`, 4 Jul 2026 → `july4`; `?holiday=birthday` → the calendar.
- [ ] **Step 2: Run** it against `npm run dev` — expect failures for the nine new looks.
- [ ] **Step 3: Implement** the table from the picked drafts (JSX attribute names; the `EDGE` style becomes the `stroke-bone/35` class; `heart` and `burst` as small helpers with the drafts' 2-decimal rounding).
- [ ] **Step 4: Run** `npm run typecheck`, `npm run lint`, `npm run check:demu`, `npm run e2e:demuholiday` with `SHOT_DIR`, `npm run e2e:typeicons`; look at every screenshot in both themes against the picker page.
- [ ] **Step 5: Commit** `feat(demu): nine new looks, picked by Chad`.

### Task 3: Docs

**Files:** `docs/ui.md` (the DeMu-page holiday bullet), `CLAUDE.md` (ui.md row: add `demu-costumes.tsx`), the old spec's Non-goals line pointing here.

- [ ] **Step 1:** Rewrite the bullet: the 11 looks and their last days, the year wrap, the moving dates, the `?holiday=` names, the verification.
- [ ] **Step 2:** `npm run check:claudemd` — expect ok.
- [ ] **Step 3: Commit** `docs(demu): the year of looks`.
