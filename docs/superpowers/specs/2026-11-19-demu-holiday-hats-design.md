# The DeMu emu in holiday hats — design

**Date:** 2026-11-19 · **Size:** a small change · **Status:** approved by Chad

## Intent

Chad: *"For the new DeMu logo we have on /DeMu can we dress it up for holidays?
Like make it look like a turkey for thanksgiving?"* The emu in headphones
(`EmuIcon`, `components/icons.tsx`) is the /demu title's logo since #606. It
should wear a costume on a holiday, and turn back by itself after it.
Thanksgiving is Thursday 26 Nov 2026, so the first costume must be live by
Wednesday 25 Nov.

## What Chad chose

From drafts on a claude.ai page (2026-11-19):

- **Thanksgiving: draft B without the wattle** — the tail feathers behind the
  emu and a pilgrim hat. His note: *"Remove the turkey beard from b and just
  leave the feathers and hat"*.
- **Christmas: a Santa hat.** He raised it: *"That also works for Xmas for a
  Santa hat"*. A red cap with a white brim and pompom, the tip hanging back
  over the headphones; no feathers.
- The plan below, answered "Done".

## Goals

- The costume shows on the /demu title only, in both brands.
- Each costume turns on and off by the calendar, with no PR and no deploy:
  - **Thanksgiving:** Monday to Sunday of the week of US Thanksgiving (the
    FOURTH Thursday of November — not the last; 2029 has five). 23–29 Nov in
    2026. When that Sunday is 1 Dec (2024, 2030), Thanksgiving keeps the day.
  - **Christmas:** 1–26 Dec.
- The visitor's own date decides (local time, like the /demu week groups).
- `/demu?holiday=thanksgiving|christmas` shows a costume on any day, for a test
  and for Chad to see one before its week. `?holiday=none` shows the plain emu.

## Non-goals

- The small emus — the search menu, `BROWSE DEMU`, the Self-hosted cover
  badge — stay plain: a costume does not read at 11–14 px.
- No other holiday now. A later one is one more window and one more layer.

## Anti-goals

- The title must not move when the costume appears. The page is prerendered,
  so the server draws the plain emu and the browser swaps in the costume after
  hydration. The costume keeps the emu's 1em box and draws past it
  (`overflow: visible`): the hat into the space above the title, the feathers
  into the gutter and the gap before the word.
- The plain emu stays byte-identical to the menu's DEMU glyph
  (`e2e:typeicons` asserts it).

## Approaches

1. **By the calendar, in the browser (chosen).** A pure, import-free
   `lib/demu-holiday.ts` answers "which costume today", pinned by
   `check:demu`. Nothing to merge or deploy each year.
2. One PR per holiday. Two merges per holiday (on and off), and a forgotten
   second merge leaves a turkey up in March.
3. A Vercel environment variable. A redeploy per change, and a Vercel step for
   Chad.

## The how

- `lib/demu-holiday.ts` (import-free, so `demu*.ts` in CLAUDE.md's list already
  names it): `thanksgivingDay(year)`, `demuHolidayOn(date)`,
  `demuHolidayFor(date, param)` (the `?holiday=` override first).
- `components/icons.tsx`: `HolidayEmuIcon({ holiday })` — the same emu paths
  as `EmuIcon` (shared constants, not a copy), with the costume layers and a
  page-coloured outline (`fill-ink`/`stroke-ink`) that keeps the emu clear of
  the feathers and the hats. The costume colours are artwork, inline hex, like
  the `/demu-apps/*.png` badges; not palette tokens.
- `components/demu-page.tsx`: the title reads the costume with
  `useSyncExternalStore` (server snapshot `null`), so the server and the first
  client render agree.
- Verification: `check:demu` vectors (with `naive()` = the LAST Thursday),
  and a new `e2e:demuholiday`: each costume by the param, the real-date path
  under a faked browser date, the plain emu outside a window, no title movement
  and no horizontal overflow at 390 px. `e2e:typeicons` loads `/demu?holiday=none`
  so it stays green during a holiday week.

## Left to the builder

The exact drawing coordinates (from the approved drafts), and the e2e details.
