// Which look the /demu title's emu wears today — Chad, 2026-11-19: "For the new
// DeMu logo we have on /DeMu can we dress it up for holidays?", then, once the
// turkey was live: "can we go through and just pre-make some art for the major
// holidays? I'm okay with it constantly changing also … if there's a big span
// between them, we could throw in some fun ones."
//
// Eleven looks, in year order. Each LEADS UP TO its day and hands over the day
// after it (Chad: "once that holiday hits, it switches over to the next
// holiday"), so the emu always wears one. New Year's crosses the year: 27 Dec
// through 1 Jan. He picked each drawing from drafts; they live in
// `components/demu-costumes.tsx`.
// Design: docs/superpowers/specs/2026-11-19-demu-holiday-year-design.md.
// Pinned by `check:demu`.
//
// IMPORT-FREE (CLAUDE.md, `demu*.ts`), so the check loads it under plain Node.
//
// Five rules, each one an obvious build that is wrong:
// - 27–31 Dec is New Year's. A table read for "this year" alone runs out after
//   Christmas and leaves the emu bare for five days.
// - Easter moves: the Gregorian computus, not this year's date. 2027 is 28 Mar.
// - Labor Day is the first Monday of September. JS `%` keeps the sign, so
//   `1 + ((1 - weekday) % 7)` gives 0 for 2026; add 7 before the `%`.
// - Thanksgiving is the FOURTH Thursday of November, not the last: 2029 has
//   five Thursdays, and the holiday is the 22nd.
// - The VISITOR'S calendar decides, in local time, like the /demu week groups.
//   A server's UTC date changes the look five hours early in New York.
//
// Nothing to merge or deploy each year: the days come from the calendar.

/** The looks, in the order the year runs through them. */
export const DEMU_HOLIDAYS = [
  'newyear', 'valentines', 'stpatricks', 'easter', 'pizzaday', 'july4',
  'summer', 'podcastday', 'halloween', 'thanksgiving', 'christmas',
] as const;
export type DemuHoliday = (typeof DEMU_HOLIDAYS)[number];

/** The day of November that is US Thanksgiving (the fourth Thursday). */
export function thanksgivingDay(year: number): number {
  const firstWeekday = new Date(year, 10, 1).getDay();
  const firstThursday = 1 + ((4 - firstWeekday + 7) % 7);
  return firstThursday + 21;
}

/** The day of September that is US Labor Day (the first Monday). */
export function laborDay(year: number): number {
  const firstWeekday = new Date(year, 8, 1).getDay();
  return 1 + ((1 - firstWeekday + 7) % 7);
}

/**
 * Western Easter Sunday, at local midnight: the anonymous Gregorian algorithm
 * (Meeus/Jones/Butcher). It falls from 22 Mar to 25 Apr, so it always comes
 * after St. Patrick's Day and before Bitcoin Pizza Day.
 */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

/** Each look's last day in `year`, in year order: [look, month 0–11, day]. */
function lastDays(year: number): [DemuHoliday, number, number][] {
  const easter = easterSunday(year);
  return [
    ['newyear', 0, 1],
    ['valentines', 1, 14],
    ['stpatricks', 2, 17],
    ['easter', easter.getMonth(), easter.getDate()],
    ['pizzaday', 4, 22],
    ['july4', 6, 4],
    ['summer', 8, laborDay(year)],
    ['podcastday', 8, 30],
    ['halloween', 9, 31],
    ['thanksgiving', 10, thanksgivingDay(year)],
    ['christmas', 11, 26],
  ];
}

/**
 * The look for this moment, in the local time of the machine that runs it: the
 * first look whose last day has not ended. After 26 Dec that is next year's
 * first look, New Year's.
 */
export function demuHolidayOn(at: Date): DemuHoliday {
  const year = at.getFullYear();
  for (const [look, month, day] of lastDays(year)) {
    if (at < new Date(year, month, day + 1)) return look;
  }
  return 'newyear';
}

/**
 * The look the title shows: `?holiday=<look>` forces one on any day (a test,
 * or a look on another day), `?holiday=none` forces the plain emu, and anything
 * else leaves it to the calendar.
 */
export function demuHolidayFor(at: Date, param: string | null | undefined): DemuHoliday | null {
  if (param === 'none') return null;
  const forced = DEMU_HOLIDAYS.find((look) => look === param);
  return forced ?? demuHolidayOn(at);
}
