# The DeMu emu, all year — design

**Date:** 2026-11-19 · **Size:** a small change · **Status:** approved by Chad

Follows `2026-11-19-demu-holiday-hats-design.md` (Thanksgiving and Christmas,
#609 and #610), which holds the drawing rules this one keeps.

## Intent

Chad, after the turkey went live: *"can we go through and just pre-make some
art for the major holidays? I'm okay with it constantly changing also, but …
I want it to be up for like the major holidays, but then, you know, if there's
a big span between them, we could throw in some fun ones."* And on #610: *"I do
want to have this be yearly."*

So the /demu title's emu wears a look every day of the year, and the year
repeats with no PR and no deploy.

## What Chad chose

The list of looks (*"That's a good list to start with"*), then one of two
drafts for each new look, on a claude.ai picker page (2026-11-19). No notes.

| Look | Chad's pick | Last day it shows |
|---|---|---|
| New Year's | A · party hat and confetti | 1 Jan |
| Valentine's Day | B · a heart over the ear cup, and floating hearts | 14 Feb |
| St. Patrick's Day | A · leprechaun hat | 17 Mar |
| Easter | A · bunny ears | Easter Sunday |
| Bitcoin Pizza Day (fun) | A · pizza-slice hat | 22 May |
| Fourth of July | B · fireworks behind the emu | 4 Jul |
| Summer (fun) | A · sunglasses | Labor Day |
| International Podcast Day (fun) | A · studio microphone | 30 Sep |
| Halloween | A · witch hat | 31 Oct |
| Thanksgiving (live) | feathers and a pilgrim hat | Thanksgiving Day |
| Christmas (live) | Santa hat | 26 Dec |

## Goals

- **Each look starts the day after the look before it ends, and shows through
  its own day** (Chad on #610: *"once that holiday hits, it switches over to the
  next holiday"*). So the emu always wears a look; there is no plain stretch.
  New Year's crosses the year: 27 Dec through 1 Jan.
- Three last days move, and the code works them out each year:
  - **Easter Sunday** — the Gregorian computus (Western Easter). 2027: 28 Mar.
  - **Labor Day** — the first Monday of September. 2027: 6 Sep.
  - **Thanksgiving** — the fourth Thursday of November (already in the code).
- The visitor's own calendar decides, in local time, as before.
- `/demu?holiday=<look>` shows a look on any day; `?holiday=none` the plain emu.
  The names: `newyear`, `valentines`, `stpatricks`, `easter`, `pizzaday`,
  `july4`, `summer`, `podcastday`, `halloween`, `thanksgiving`, `christmas`.

## Non-goals

- The planning page — a part of the site to design and schedule looks. It is
  the roadmap item "Holiday logos, every year" under To plan. This PR does not
  start it.
- The small emus stay plain, as before.

## Anti-goals

- Every rule of the first design stays: the title does not move when the look
  arrives after hydration; the look draws past the emu's 1em box; every gap is
  an SVG mask, never the page colour painted; the emu inside is the same
  `EmuShapes`; the emu's eye stays open — except under the sunglasses, which
  cover it on purpose.

## Approaches

1. **One ordered table of looks in the code, dates from the calendar
   (chosen).** `lib/demu-holiday.ts` lists the looks in year order with each
   one's last day; the first look whose last day has not passed is today's.
   The art is inline SVG in the code, like the turkey and Santa.
2. Dates and art from an admin page or a database. That is the planning page,
   which Chad wants later; it is the roadmap item, not this PR.
3. Art as image files. They lose the masks and the theme colour (the emu is
   `currentColor` in bolt), so a look would read on one theme only.

## The how

- `lib/demu-holiday.ts` (import-free, pinned by `check:demu`):
  `DEMU_HOLIDAYS` (the 11 names in year order), `easterSunday(year)`,
  `laborDay(year)`, `thanksgivingDay(year)`; `demuHolidayOn(at)` now always
  returns a look; `demuHolidayFor(at, param)` takes any of the 11 names, or
  `none`.
- The art moves out of `components/icons.tsx` into
  `components/demu-costumes.tsx`: one table, look → `{ back, front, gap }`.
  `back` draws behind the emu and is masked off its silhouette; `front` draws
  over it; `gap` is the black shapes cut from the emu round `front`.
  `HolidayEmuIcon` draws any entry. The shapes are the drafts Chad picked,
  unchanged.
- `check:demu` gets a vector at each look's last minute and at the next look's
  first minute, the moving dates in several years, and a `naive()` with the
  obvious wrong builds: no year wrap (27–31 Dec bare), this year's Easter date
  hard-coded, Labor Day by a JS `%` that goes negative, the last Thursday for
  Thanksgiving, and UTC dates.
- `e2e:demuholiday` drives every look at 390 and 320 px, and the calendar under
  a faked clock, including 27 Dec (the year wrap).

## Calls Claude made

- 1 Nov as the turkey's first day stays (it is the day after Halloween now).
- The `?holiday=` names above.
- The Easter look follows Western Easter, the one US calendars print.
