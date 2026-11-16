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
 * A feed Fountain made or hosts: generator Fountain, or a feed on fountain.fm.
 * Not DeMu since 2026-11-16 — Chad dropped Fountain from /demu ("Can we also hide
 * fountain hosted feeds?") and then from this search type ("Fountain needs removed
 * there too"). The host half is exact: `notfountain.fm.example.com` is not Fountain.
 */
export function isFountainFeed(row: DemuRow): boolean {
  if (/^fountain\b/i.test((row.generator ?? '').trim())) return true;
  let host = '';
  try {
    host = new URL(row.url ?? '').hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'fountain.fm' || host.endsWith('.fountain.fm');
}

/**
 * Whether one feed record is self-hosted by Chad's rule: no "wavlake" in its
 * generator, case-insensitively, not made or hosted by Fountain
 * (`isFountainFeed`), and not on a closed host. A row with no `generator`
 * field at all FAILS CLOSED (see `DemuRow.generator`).
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
  if (isFountainFeed(row)) return false;
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
  /**
   * True when the album is shown WITHOUT a value block — Homegrown Hits plays it or
   * MSP made it — and Podcast Index's batch answer said it has none. The page stamps
   * it `NO VALUE BLOCK` (Chad, 2026-11-16). Absent means "has one" or "not known":
   * never set from a guid the batch did not answer.
   */
  valueMissing?: true;
  /**
   * The app that made the feed, from its `generator` (`demuAppOf`): the page puts
   * that app's logo in the cover's top-left corner, LNBeats' idea — "just for at a
   * glance" (Chad, 2026-11-16). Optional only because a cached answer from before
   * the field existed has none; the page then draws no badge.
   */
  app?: DemuApp;
}

/** Every app with a badge; `self` is anything else (a house, drawn inline). */
export type DemuApp = 'fountain' | 'msp' | 'sovereign' | 'podhome' | 'self';

/**
 * The badge words, for the tooltip and the screen reader. The pictures are
 * `public/demu-apps/<app>.png` (96 px), taken from each app's own site — see the
 * DeMu page section of docs/ui.md for where each came from. `check:demu` fails
 * when an app here has no picture.
 */
export const DEMU_APPS: Record<DemuApp, { label: string }> = {
  fountain: { label: 'Fountain' },
  msp: { label: 'MSP' },
  sovereign: { label: 'Sovereign Feeds' },
  podhome: { label: 'Podhome' },
  self: { label: 'Self-hosted' },
};

/** "Made by MSP": "MSP" as a word, or "Music Side Project" — both spellings on the wire. */
export function isMspGenerator(generator: string | undefined): boolean {
  return /\bmsp\b|music side project/i.test(generator ?? '');
}

/**
 * Which app made a feed, from PI's `generator`. Matched by NAME, never by host:
 * Sovereign Feeds writes feeds that live on the artists' own sites. Only the exact
 * tool names count — `sovereign-music-feed-generator` is a different tool (13 feeds
 * on one artist's site, 2026-11-16) and gets the house like every other self-made feed.
 */
export function demuAppOf(generator: string | undefined): DemuApp {
  const g = (generator ?? '').trim();
  if (/^fountain\b/i.test(g)) return 'fountain';
  if (isMspGenerator(g)) return 'msp';
  if (/^sovereign feeds\b/i.test(g)) return 'sovereign';
  if (/^podhome\b/i.test(g)) return 'podhome';
  return 'self';
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
/**
 * A feed Fountain made or hosts: generator Fountain, or a feed on fountain.fm.
 * Chad, 2026-11-16 ("Can we also hide fountain hosted feeds?", option B): none of
 * them is on /demu — not even the 74 Homegrown Hits plays — so `demuRosterRows`
 * drops them before `keepForDemu`'s played rule can bring one back. The DEMU
 * search type is NOT changed: `isDemuFeed` still counts Fountain.
 */
export function isFountainFeed(row: DemuRow): boolean {
  if (demuAppOf(row.generator) === 'fountain') return true;
  let host = '';
  try {
    host = new URL(row.url ?? '').hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'fountain.fm' || host.endsWith('.fountain.fm');
}

export function demuRosterRows(
  rows: readonly PiMusicRow[],
  closedService: (url: string) => string | null,
): DemuAlbum[] {
  const byGuid = new Map<string, DemuAlbum>();
  const noGuid: DemuAlbum[] = [];
  for (const row of rows) {
    if (row.dead === 1 || !isDemuFeed(row, closedService) || isFountainFeed(row)) continue;
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
      app: demuAppOf(row.generator),
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

/**
 * A whole `/podcasts/bymedium?medium=music` answer → the roster, or `null` when
 * the answer READ NOTHING: no body, no `feeds` list, an empty list, or rows that
 * all fail (every row without `generator` fails closed, so a PI schema change
 * that drops the field lands here). `null` means "do not cache, say could not
 * load"; flattening it into `[]` cached six hours of "0 DeMu albums" over a
 * broken answer (final review, 2026-11-15). There are ~1,100 DeMu albums, so a
 * real answer with none is not a state worth trusting.
 */
export function demuRosterFromPi(
  data: unknown,
  closedService: (url: string) => string | null,
): DemuAlbum[] | null {
  const feeds = (data as { feeds?: unknown } | null)?.feeds;
  if (!Array.isArray(feeds) || feeds.length === 0) return null;
  const albums = demuRosterRows(feeds as PiMusicRow[], closedService);
  return albums.length ? albums : null;
}

// ─── Chad's V4V rule: no <podcast:value>, not on /demu ───────────────────────
//
// Chad, 2026-11-16, about a radio station's archive on the list: "Remove
// anything that doesn't have <podcast:value>". It removes the radio stations
// and DJ-mix shows that declare `medium=music` without a value block (UXRZONE,
// Mixing Podcast Amsterdam, Techno Live Sets…) and the talk show filed as
// music (The Board Game Design Lab). It does NOT remove Radio 1 Timemachine,
// which has one — Chad was told, and chose this rule.
//
// `/podcasts/bymedium` rows carry no `value`, so the roster asks two sources:
// PI's static file of every feed with a value block (one fetch, no key, but
// days old), and for the feeds that file does not list — new releases mostly —
// the live `/podcasts/batch/byguid`, whose `valueBlock` is a JSON STRING or
// null. These functions decide; lib/pi.ts asks.

/** Whether one value block — an object (the static file) or a JSON string (the batch call) — names anyone to pay. */
export function hasValueBlock(raw: unknown): boolean {
  let v: unknown = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return false; }
  }
  if (!v || typeof v !== 'object') return false;
  const block = v as { destinations?: unknown; recipients?: unknown };
  const named = (list: unknown) => Array.isArray(list) && list.length > 0;
  return named(block.destinations) || named(block.recipients);
}

/**
 * The guids (lower-cased) of roster albums the static value file does not list
 * — the ones to ask the batch call about. `skip` holds guids already decided
 * either way (played by Homegrown Hits, or hidden), which need no question.
 */
export function demuValueGaps(
  albums: readonly DemuAlbum[],
  valueIds: ReadonlySet<number>,
  skip: ReadonlySet<string> = new Set(),
): string[] {
  return albums
    .filter((a) => !valueIds.has(a.id) && a.podcastGuid && !skip.has(a.podcastGuid.toLowerCase()))
    .map((a) => (a.podcastGuid as string).toLowerCase());
}

/**
 * The lower-cased guids of the rows Music Side Project made — Chad, 2026-11-16:
 * "Any feed made by MSP gets shown", and "MSP or MSP 2.0 or MSP Studio would be
 * in the generator tag". On the wire that day: "Music Side Project Studio"
 * (221) and "MSP 2.0 - Music Side Project Studio" (101). "MSP" is matched as a
 * WORD, so a tool whose name only starts with those letters is not MSP.
 */
export function mspFeedGuids(rows: readonly PiMusicRow[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.podcastGuid && isMspGenerator(r.generator)) out.add(r.podcastGuid.toLowerCase());
  }
  return out;
}

/**
 * The NO VALUE BLOCK stamp, checked against each feed's own RSS. `rss` maps a
 * lower-cased guid to `true` (the RSS has a `<podcast:value>` somewhere — on an
 * item counts), `false` (read, and none), or `null`/absent (not read). The mark
 * stays only on `false`: PI's value data is channel-level, so MOOKY's item-level
 * block reads there as none, and an unreadable feed is "not known", never
 * "missing". Albums without the mark pass through unchanged.
 */
export function confirmValueMissing(
  albums: readonly DemuAlbum[],
  rss: ReadonlyMap<string, boolean | null>,
): DemuAlbum[] {
  return albums.map((a) => {
    if (!a.valueMissing) return a;
    if (a.podcastGuid && rss.get(a.podcastGuid.toLowerCase()) === false) return a;
    const rest: DemuAlbum = { ...a };
    delete rest.valueMissing;
    return rest;
  });
}

/**
 * What /demu shows, in Chad's order (2026-11-16):
 * 1. **Played by Homegrown Hits** (`played`, lower-cased guids) — always shown,
 *    with or without a value block, and the hide list cannot remove it.
 * 2. **On the hide list** (`hidden`) — never shown.
 * 3. **Made by MSP** (`msp`) — shown with or without a value block. Below the
 *    hide list: a line naming one feed is more specific than "any MSP feed"
 *    (DJ Criket's mixes are MSP-made, and Chad hid them by name).
 * 4. **Everything else needs `<podcast:value>`** — `keepWithValue`.
 * Every album here already passed `demuRosterRows` (music, not Wavlake, not a
 * closed host, not dead), so a played feed that nobody can play stays out.
 */
export function keepForDemu(
  albums: readonly DemuAlbum[],
  rule: {
    valueIds: ReadonlySet<number>;
    batch: ReadonlyMap<string, boolean>;
    played: ReadonlySet<string>;
    hidden: ReadonlySet<string>;
    msp?: ReadonlySet<string>;
    /** Exact author names (after a trim) hidden like a guid — LNBeats' allowFeed(). */
    hiddenAuthors?: ReadonlySet<string>;
  },
): DemuAlbum[] {
  const out: DemuAlbum[] = [];
  for (const a of albums) {
    const guid = a.podcastGuid?.toLowerCase();
    // Shown with or without a value block: say so when the batch call said none.
    const shownAnyway = () => {
      const missing = !!guid && !rule.valueIds.has(a.id) && rule.batch.get(guid) === false;
      out.push(missing ? { ...a, valueMissing: true } : a);
    };
    if (guid && rule.played.has(guid)) { shownAnyway(); continue; }
    if (guid && rule.hidden.has(guid)) continue;
    if (a.author && rule.hiddenAuthors?.has(a.author.trim())) continue;
    if (guid && rule.msp?.has(guid)) { shownAnyway(); continue; }
    if (keepWithValue([a], rule.valueIds, rule.batch).length === 1) out.push(a);
  }
  return out;
}

/**
 * The albums with a value block: listed in the static file, or answered `true`
 * by the batch call (keyed by lower-cased guid). An album nobody answered for
 * is NOT kept — the rule keeps proven value blocks only.
 */
export function keepWithValue(
  albums: readonly DemuAlbum[],
  valueIds: ReadonlySet<number>,
  batch: ReadonlyMap<string, boolean>,
): DemuAlbum[] {
  return albums.filter((a) => valueIds.has(a.id) || (!!a.podcastGuid && batch.get(a.podcastGuid.toLowerCase()) === true));
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
