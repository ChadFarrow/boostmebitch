// Which holiday hat the /demu title's emu wears today — Chad, 2026-11-19:
// "For the new DeMu logo we have on /DeMu can we dress it up for holidays?"
// Each look LEADS UP TO its holiday and hands over the day after it (Chad, the
// same day: "once that holiday hits, it switches over to the next holiday"):
// the turkey from 1 Nov through Thanksgiving Day, then Santa from Black Friday
// through 26 Dec. 27 Dec to 31 Oct is the plain emu until another look exists.
// Design: docs/superpowers/specs/2026-11-19-demu-holiday-hats-design.md.
// Pinned by `check:demu`; drawn by `HolidayEmuIcon` (components/icons.tsx).
//
// IMPORT-FREE (CLAUDE.md, `demu*.ts`), so the check loads it under plain Node.
//
// Three rules, each one an obvious build that is wrong:
// - Thanksgiving is the FOURTH Thursday of November, not the last: 2029 has
//   five Thursdays, and the holiday is the 22nd.
// - The VISITOR'S calendar decides, in local time, like the /demu week groups.
//   A server's UTC date turns the hat on and off five hours early in New York.
// - Santa starts on Black Friday, not on 1 Dec: the first schedule waited for
//   December and left the emu bare for Black Friday weekend.
//
// Nothing to merge or deploy each year: the windows come from the calendar.

export type DemuHoliday = 'thanksgiving' | 'christmas';

/** The day of November that is US Thanksgiving (the fourth Thursday). */
export function thanksgivingDay(year: number): number {
  const firstWeekday = new Date(year, 10, 1).getDay();
  const firstThursday = 1 + ((4 - firstWeekday + 7) % 7);
  return firstThursday + 21;
}

/**
 * The hat for this moment, in the local time of the machine that runs it:
 * Thanksgiving from 1 Nov 00:00 to Black Friday 00:00, then Christmas from
 * Black Friday 00:00 to 27 Dec 00:00; otherwise none.
 */
export function demuHolidayOn(at: Date): DemuHoliday | null {
  const year = at.getFullYear();
  const blackFriday = new Date(year, 10, thanksgivingDay(year) + 1);
  if (at >= new Date(year, 10, 1) && at < blackFriday) return 'thanksgiving';
  if (at >= blackFriday && at < new Date(year, 11, 27)) return 'christmas';
  return null;
}

/**
 * The hat the title shows: `?holiday=thanksgiving|christmas` forces one on any
 * day (a test, or a look on another day), `?holiday=none` forces the plain emu,
 * and anything else leaves it to the calendar.
 */
export function demuHolidayFor(at: Date, param: string | null | undefined): DemuHoliday | null {
  if (param === 'none') return null;
  if (param === 'thanksgiving' || param === 'christmas') return param;
  return demuHolidayOn(at);
}
