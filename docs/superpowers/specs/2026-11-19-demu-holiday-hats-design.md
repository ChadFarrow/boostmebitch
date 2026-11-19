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
  - **Thanksgiving:** from 1 Nov through Thanksgiving Day (the FOURTH
    Thursday of November — not the last; 2029 has five). 1–26 Nov in 2026.
  - **Christmas:** from Black Friday (the day after) through 26 Dec.
  - The first build ran Thanksgiving Monday to Sunday of its week and Christmas
    1–26 Dec (#609). Chad changed it the same day — see *Change, 2026-11-19*.
- The visitor's own date decides (local time, like the /demu week groups).
- `/demu?holiday=thanksgiving|christmas` shows a costume on any day, for a test
  and for Chad to see one on another day. `?holiday=none` shows the plain emu.

## Non-goals

- The small emus — the search menu, `BROWSE DEMU`, the Self-hosted cover
  badge — stay plain: a costume does not read at 11–14 px.
- No other holiday now. A later one is one more window and one more layer.
  (Later the same day the year got eleven looks: see
  `2026-11-19-demu-holiday-year-design.md`.)

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
  as `EmuIcon` (shared constants, not a copy), with the costume layers. SVG
  masks keep the emu clear of the feathers and the hats, and keep its eye open.
  (The first build painted a `fill-ink`/`stroke-ink` outline instead. The page
  behind the title is the hero image under `bg-ink/75`, not `--ink`, so that
  outline showed as a cream sticker edge on the light theme.) The costume
  colours are artwork, inline hex, like the `/demu-apps/*.png` badges; not
  palette tokens.
- `components/demu-page.tsx`: the title reads the costume with
  `useSyncExternalStore` (server snapshot `null`), so the server and the first
  client render agree.
- Verification: `check:demu` vectors (with `naive()` = the LAST Thursday),
  and a new `e2e:demuholiday`: each costume by the param, the real-date path
  under a faked browser date, the plain emu outside a window, no title movement
  and no horizontal overflow at 390 px. `e2e:typeicons` loads `/demu?holiday=none`
  so it stays green while a costume is in season.

## Left to the builder

The exact drawing coordinates (from the approved drafts), and the e2e details.

## Change, 2026-11-19

After #609 merged, Chad asked for the turkey now, not on 23 Nov: *"So the idea
is that we change it leading up to the next holiday, and then once that holiday
hits, it switches over to the next holiday. So like we put the turkey on there
now, and then the day after, which I guess would be Black Friday, it switches
over to Santa, and then it stays Santa until the 26th of December, and then it
is a New Year's one, I guess, but that'll all have to be planned out."*

- Each look leads up to its holiday and hands over the day after.
- Turkey: 1 Nov through Thanksgiving Day. **1 Nov is Claude's call**, for "leading
  up to" with no earlier look before it (the day after Halloween); Chad can move it.
- Santa: Black Friday through 26 Dec, as Chad said.
- 27 Dec to 31 Oct: the plain emu. The New Year's look is not drawn; Chad plans it,
  with a place on the site to design the holiday logos and plan their dates each
  year (his second message: *"there should be a part of the site set aside for
  designing and planning when these logos change, because I do want to have this
  be yearly."*).
