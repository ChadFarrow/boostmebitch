// Which holiday hat the /demu title's emu wears today — Chad, 2026-11-19:
// "For the new DeMu logo we have on /DeMu can we dress it up for holidays?"
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
// - Thanksgiving week runs Monday to Sunday, and its Sunday can be 1 Dec (2024,
//   2030). Thanksgiving keeps that day; Santa starts the day after.
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
 * Thanksgiving from the Monday before to the Sunday after (Monday 00:00 to the
 * next Monday 00:00), then Christmas from 1 Dec to 26 Dec; otherwise none.
 */
export function demuHolidayOn(at: Date): DemuHoliday | null {
  const year = at.getFullYear();
  const thursday = thanksgivingDay(year);
  // `new Date(y, 10, 32)` is 2 Dec: the constructor rolls a day past the month.
  const weekStart = new Date(year, 10, thursday - 3);
  const weekEnd = new Date(year, 10, thursday + 4);
  if (at >= weekStart && at < weekEnd) return 'thanksgiving';
  if (at >= new Date(year, 11, 1) && at < new Date(year, 11, 27)) return 'christmas';
  return null;
}

/**
 * The hat the title shows: `?holiday=thanksgiving|christmas` forces one on any
 * day (a test, or a look before its week), `?holiday=none` forces the plain emu,
 * and anything else leaves it to the calendar.
 */
export function demuHolidayFor(at: Date, param: string | null | undefined): DemuHoliday | null {
  if (param === 'none') return null;
  if (param === 'thanksgiving' || param === 'christmas') return param;
  return demuHolidayOn(at);
}
