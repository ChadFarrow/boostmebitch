// Which search rows the DEMU search type keeps — the self-hosted half of the
// rule. The lane in `app/api/search/route.ts` applies the music half.
//
// IMPORT-FREE, not even `import type`: `npm run check:demu` loads this file
// under plain Node (`scripts/import-free.mjs`). That is why the closed-host
// test arrives as a PARAMETER rather than an import: `lib/moved-feeds.ts` stays
// the one list of closed hosts, and every caller passes its `closedService`.
//
// **What DeMu means here (Chad, 2026-11-15):** "anything that's self-hosted …
// on a user's own website or fountain.fm also counts … RSS Blue did until they
// went away, and PodHome would also count. Basically anything that's not
// Wavlake." And: "anything with a generator tag of Wavlake isn't on this list.
// So if it's a Wavlake generator tag, but it's hosted somewhere else, then that
// still gets removed."
//
// **Why the generator and never the host.** Measured against Podcast Index's
// 8,671 music feeds: every feed on wavlake.com carries the Wavlake generator,
// and 5 Wavlake QA feeds carry it on a `run.app` host. A host test keeps those
// five. LNBeats, the site this copies, tested `!generator.includes('Wavlake')`
// (`thebells1111/lnbeats`, `src/components/Discover/Discover.svelte`); this
// test is the same, made case-insensitive.
//
// **Why a closed host is not DeMu.** RSS Blue closed in 2026 and answers 410
// for every feed, while Podcast Index still serves those records as healthy. A
// listener who finds one cannot play it or request it, and an artist who moved
// shows under the new feed. `closedService` already knows this (see
// `lib/moved-feeds.ts`).
//
// Design: docs/superpowers/specs/2026-11-15-demu-search-design.md.

/** The two fields of a Podcast Index feed record the rule reads. */
export interface DemuRow {
  /**
   * The feed's `<generator>`. BLANK passes: Podcast Index sends `""` for a feed
   * without one, and 190 DeMu feeds have none. ABSENT fails: PI always sends
   * the key and `buildPodcast` keeps it, so a row without it was built by
   * something that dropped the field, and passing it would call every Wavlake
   * album DeMu.
   */
  generator?: string;
  /** The feed URL. */
  url?: string;
}

/**
 * Whether one feed record is self-hosted by Chad's rule: no "wavlake" in its
 * generator, case-insensitively, and not on a closed host. A row with no
 * `generator` field at all FAILS CLOSED (see `DemuRow.generator`).
 *
 * This does NOT test the medium. The DEMU lane runs the music lanes, and
 * `matchesSearchType(p, 'demu')` applies the music test to byterm's rows.
 */
export function isDemuFeed(
  row: DemuRow,
  closedService: (url: string) => string | null,
): boolean {
  if (typeof row.generator !== 'string') return false;
  if (/wavlake/i.test(row.generator)) return false;
  return closedService(row.url ?? '') === null;
}

// ─── The /demu list ──────────────────────────────────────────────────────────
//
// Design: docs/superpowers/specs/2026-11-15-demu-page-design.md. The server
// builds the roster with `demuRosterRows`; the page sorts, groups, ages and
// filters it with the rest. All pure, all pinned by `check:demu`, which runs in
// New York time on purpose: every date here is the VIEWER'S local date, and a
// function that reads UTC fields puts a Sunday-evening track in next week.

/** One row of the /demu list — exactly what a row, the ♥ and `selectPodcast` need. */
export interface DemuAlbum {
  id: number;
  podcastGuid?: string;
  title: string;
  author?: string;
  image?: string;
  artwork?: string;
  url?: string;
  /**
   * Always `'music'`: the roster asks PI for that medium. REQUIRED, because
   * `<FavHeart>` writes `declaredMedium(podcast)` into the shared kind:10333
   * favorites event — a row without it saves a favorite with no medium,
   * publicly, with no undo.
   */
  medium: 'music';
  /** Unix seconds of the feed's newest track (PI's `newestItemPubdate`). */
  newestItemPubdate?: number;
  episodeCount?: number;
}

/** The fields of one `/podcasts/bymedium?medium=music` row this file reads. */
export interface PiMusicRow extends DemuRow {
  id: number;
  podcastGuid?: string;
  title?: string;
  author?: string;
  image?: string;
  artwork?: string;
  dead?: number;
  newestItemPubdate?: number;
  episodeCount?: number;
}

/**
 * Podcast Index's music feeds → the /demu roster.
 *
 * Drops a feed PI marks `dead` (a listener who finds one cannot play or request
 * it — the reason closed hosts go, and `lib/moved-feeds.ts` skips dead rows the
 * same way), drops every row `isDemuFeed` refuses, and keeps ONE row per
 * `podcastGuid`: PI holds some albums twice under one guid (LNBeats kept a
 * `dupes.json` of them), and two rows would share one ♥. The newer
 * `newestItemPubdate` wins, ties to the higher `id`; rows without a guid are all
 * kept. Output order is not specified — the page sorts.
 *
 * `generator` is read here and NOT copied out: the page has no use for it.
 */
export function demuRosterRows(
  rows: readonly PiMusicRow[],
  closedService: (url: string) => string | null,
): DemuAlbum[] {
  const byGuid = new Map<string, DemuAlbum>();
  const noGuid: DemuAlbum[] = [];
  for (const row of rows) {
    if (row.dead === 1 || !isDemuFeed(row, closedService)) continue;
    const a: DemuAlbum = {
      id: row.id,
      podcastGuid: row.podcastGuid || undefined,
      title: row.title ?? '',
      author: row.author || undefined,
      // Same two-source rule as `buildPodcast` in lib/pi.ts: PI maps
      // <image><url> to `image` and <itunes:image> to `artwork`, and they can
      // disagree; `artwork` is kept only as a second chance.
      image: row.image || row.artwork || undefined,
      artwork: row.artwork && row.artwork !== row.image ? row.artwork : undefined,
      url: row.url || undefined,
      medium: 'music',
      newestItemPubdate:
        typeof row.newestItemPubdate === 'number' && row.newestItemPubdate > 0 ? row.newestItemPubdate : undefined,
      episodeCount: typeof row.episodeCount === 'number' ? row.episodeCount : undefined,
    };
    if (!a.podcastGuid) {
      noGuid.push(a);
      continue;
    }
    const key = a.podcastGuid.toLowerCase();
    const held = byGuid.get(key);
    if (!held || isNewer(a, held)) byGuid.set(key, a);
  }
  return [...byGuid.values(), ...noGuid];
}

function isNewer(a: DemuAlbum, b: DemuAlbum): boolean {
  const da = a.newestItemPubdate ?? 0;
  const db = b.newestItemPubdate ?? 0;
  return da !== db ? da > db : a.id > b.id;
}

/**
 * Newest track first. A FUTURE date sorts as `nowSec` — a scheduled or wrong
 * date must not hold the top of the list for weeks — ties go to the higher
 * `id`, and a row with no date goes last.
 */
export function sortDemuAlbums(albums: readonly DemuAlbum[], nowSec: number): DemuAlbum[] {
  const key = (a: DemuAlbum) =>
    a.newestItemPubdate === undefined ? -Infinity : Math.min(a.newestItemPubdate, nowSec);
  return [...albums].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return kb > ka ? 1 : -1;
    return b.id - a.id;
  });
}

/** One heading of the /demu list and the rows under it. */
export interface DemuGroup {
  key: string;
  label: string;
  albums: DemuAlbum[];
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAY_MS = 86_400_000;
/** This week plus the seven before it. */
const WEEKLY_GROUPS = 8;
/** Months before the weekly window; anything older goes to its year. */
const MONTHLY_GROUPS = 12;

/** Local midnight of the day `d` falls on. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Local Monday 00:00 of the week `d` falls in (weeks run Monday to Sunday). */
function mondayOf(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
}

/**
 * Whole local calendar days from `a` to `b`. `Math.round`, not `floor`: a DST
 * change makes one day 23 or 25 hours long, and it is still one day.
 */
function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);
}

const monthDay = (d: Date) => `${MON[d.getMonth()]} ${d.getDate()}`;

/** The heading a row with this date falls under, relative to `now`. */
function groupOf(sec: number | undefined, now: Date): { key: string; label: string } {
  if (sec === undefined) return { key: 'none', label: 'No date' };
  const d = new Date(Math.min(sec * 1000, now.getTime()));
  const thisMonday = mondayOf(now);
  const monday = mondayOf(d);
  const weeksAgo = Math.round(daysBetween(monday, thisMonday) / 7);
  if (weeksAgo < WEEKLY_GROUPS) {
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    const range = monday.getMonth() === sunday.getMonth()
      ? `${monthDay(monday)}–${sunday.getDate()}`
      : `${monthDay(monday)}–${monthDay(sunday)}`;
    if (weeksAgo === 0) return { key: 'w0', label: `This week · ${range}` };
    if (weeksAgo === 1) return { key: 'w1', label: `Last week · ${range}` };
    return { key: `w${weeksAgo}`, label: `Week of ${monthDay(monday)}` };
  }
  const windowStart = new Date(
    thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 7 * (WEEKLY_GROUPS - 1),
  );
  const monthsBack = (windowStart.getFullYear() - d.getFullYear()) * 12 + windowStart.getMonth() - d.getMonth();
  if (monthsBack < MONTHLY_GROUPS) {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return { key: `m${d.getFullYear()}-${mm}`, label: `${MONTH[d.getMonth()]} ${d.getFullYear()}` };
  }
  return { key: `y${d.getFullYear()}`, label: String(d.getFullYear()) };
}

/**
 * An ALREADY SORTED list (`sortDemuAlbums`) cut into headings: the 8 most
 * recent weeks, then the 12 months before them, then years, then `No date`.
 * Consecutive rows that share a heading share a group, so an empty heading is
 * never produced.
 */
export function demuGroups(sorted: readonly DemuAlbum[], now: Date): DemuGroup[] {
  const out: DemuGroup[] = [];
  for (const a of sorted) {
    const g = groupOf(a.newestItemPubdate, now);
    const last = out[out.length - 1];
    if (last && last.key === g.key) last.albums.push(a);
    else out.push({ ...g, albums: [a] });
  }
  return out;
}

/** How old a row's newest track is: `upcoming`, `today`, `3 days`, `2 weeks`, `2 months`, `1 year`. */
export function demuAge(sec: number | undefined, now: Date): string {
  if (sec === undefined) return '';
  if (sec * 1000 > now.getTime()) return 'upcoming';
  const d = daysBetween(new Date(sec * 1000), now);
  if (d <= 0) return 'today';
  if (d === 1) return '1 day';
  if (d < 14) return `${d} days`;
  if (d < 60) return `${Math.floor(d / 7)} weeks`;
  if (d < 365) return `${Math.floor(d / 30)} months`;
  const y = Math.floor(d / 365);
  return y === 1 ? '1 year' : `${y} years`;
}

/** `Nov 14` in the current year, `Jun 1, 2024` in any other. */
export function demuDateLabel(sec: number | undefined, now: Date): string {
  if (sec === undefined) return '';
  const d = new Date(sec * 1000);
  return d.getFullYear() === now.getFullYear() ? monthDay(d) : `${monthDay(d)}, ${d.getFullYear()}`;
}

/** The /demu search: a trimmed, case-insensitive match on title or artist. An empty query matches. */
export function matchesDemuQuery(album: { title?: string; author?: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (album.title ?? '').toLowerCase().includes(q) || (album.author ?? '').toLowerCase().includes(q);
}
