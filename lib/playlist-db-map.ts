import type { Episode } from './types';

/**
 * Turning a row of the StableKraft playlist database into a track this app renders.
 *
 * **Type-only imports, and it must stay that way** — `npm run check:playlistdb`
 * runs this module under `node --experimental-strip-types`, so the check pins
 * the shipping code rather than a reimplemented copy, which is the exact
 * failure the other check scripts were written against. A type-only import
 * erases; a VALUE import does not resolve at all, because Node's ESM loader
 * wants the `.ts` extension TypeScript omits. That is not a style rule, it is
 * what the whole pin rests on. Same terms as `lib/util.ts`.
 *
 * The database is another application's, reached read-only. **A row carries no
 * payee.** The database has a value column under the same field names ours uses,
 * so a cast would look correct, and it is a crawl, months behind: on one 8-row page
 * of It's A Mood, 8 of 8 blocks disagreed with the live feed, two of them naming a
 * different node. Only a track's own feed names who it pays (`/api/item-value`).
 *
 * **Refusal is the safe direction here:** a `null` from `dbRowToEpisode` sends the
 * row to Podcast Index, so anything not recognised with certainty returns null.
 */

/** One row of the join, as the database hands it over. */
export interface DbTrackRow {
  itemGuid: unknown;
  feedGuid: unknown;
  title: unknown;
  audioUrl: unknown;
  duration: unknown;
  image: unknown;
  publishedAt: unknown;
  chaptersUrl: unknown;
  /** Read only to REFUSE the row — see `dbRowToEpisode`. Never mapped. */
  valueTimeSplits: unknown;
  /** Read only to REFUSE the row — see `dbRowToEpisode`. Never mapped. */
  alternateEnclosures: unknown;
}

/**
 * A database row as an `Episode`, or null when it cannot stand in for one.
 *
 * **`enclosureUrl` is the test, not the title.** A row with no audio is not a
 * playable track, and returning it would put a dead row on screen in the place
 * where Podcast Index would have put a real one — worse than a miss, because a
 * miss falls through and this would not.
 *
 * **A row is REFUSED when the database holds a field this mapper does not
 * carry.** An accelerator that answers with LESS than the thing it replaces is
 * not a cache, it is a silent downgrade — and the two fields in question are
 * the expensive kind. `valueTimeSplits` decides who gets paid during a track,
 * so dropping it would move money from a featured artist to the track owner
 * with every leg reporting ✓; `alternateEnclosures` is what the player picks a
 * stream from. Rather than map a second money-critical shape for the sake of a
 * handful of rows, both are read only to fall through. Measured over the 8,807
 * playlist rows: 8 carry `valueTimeSplits` and 33 carry `alternateEnclosures`,
 * so this costs 41 Podcast Index lookups and buys certainty.
 *
 * `chaptersUrl` IS carried, because it is a plain URL that the client fetches
 * through `/api/chapters` and validates for itself — 381 rows have one, and
 * dropping it would quietly cost those tracks their chapters.
 *
 * `id`, `feedId`, `playlistGroup` and `playlistPlays` are all supplied by the
 * caller. `feedId` is the container's synthetic id, which this module cannot
 * know; `id` is the shared row identity described below; and the two markers
 * come from the playlist's own `<podcast:txt>` tags rather than from the
 * database, so the heading a track appears under and the play count it shows
 * are always the ones the curator wrote.
 */
export function dbRowToEpisode(
  row: DbTrackRow,
  opts: { id: number; feedId: number; playlistGroup?: string; playlistPlays?: number },
): Episode | null {
  const guid = typeof row.itemGuid === 'string' ? row.itemGuid : '';
  const enclosureUrl = typeof row.audioUrl === 'string' ? row.audioUrl.trim() : '';
  if (!guid || !enclosureUrl) return null;
  // Anything we would drop sends the whole row to Podcast Index instead.
  if (carriesData(row.valueTimeSplits) || carriesData(row.alternateEnclosures)) return null;
  const title = typeof row.title === 'string' ? row.title : '';

  const ep: Episode = {
    // **The id is handed IN, and that is deliberate.** It must equal the one
    // the route's `placeholder` builds for the same ref — the id is a React key
    // and what `playNext`/`playPrev` locate a track by, so one row resolved
    // here and the same row resolved from Podcast Index must not become two
    // different tracks. Computing it here would mean copying `fnvHash`, which
    // cannot be imported into a module that has to load under type-stripping;
    // a hand transcription got it wrong on the first attempt (the real one
    // masks with `& 0x7fffffff` and folds `>>> 0` inside the loop). One caller,
    // one expression, nothing to drift.
    id: opts.id,
    guid,
    title,
    enclosureUrl,
    feedId: opts.feedId,
  };
  if (typeof row.feedGuid === 'string' && row.feedGuid) ep.podcastGuid = row.feedGuid;
  if (typeof row.duration === 'number' && Number.isFinite(row.duration) && row.duration > 0) {
    ep.duration = Math.round(row.duration);
  }
  if (typeof row.image === 'string' && row.image) ep.image = row.image;
  if (typeof row.chaptersUrl === 'string' && /^https?:\/\//i.test(row.chaptersUrl)) {
    ep.chaptersUrl = row.chaptersUrl;
  }
  const published = pubDate(row.publishedAt);
  if (published) ep.datePublished = published;
  if (opts.playlistGroup) ep.playlistGroup = opts.playlistGroup;
  if (opts.playlistPlays) ep.playlistPlays = opts.playlistPlays;
  return ep;
}

/**
 * Whether the column carries something this mapper would drop.
 *
 * **It answers "is this certainly absent?" and refuses everything else** — the
 * inverse of testing for a non-empty array, which is how it shipped. `pg`
 * decodes a `Json` column into a JS array today, so `Array.isArray(raw) &&
 * raw.length > 0` looked equivalent; it is not. An object map (`{"0": {...}}`),
 * a column whose Prisma type moves from `Json` to `String` (so the array
 * arrives as the *text* `'[{"startTime":8,...}]'`), or any driver change that
 * hands back something else all read as FALSE, which silently skips the refusal
 * — and the refusal is the whole guard. `valueTimeSplits` decides who is paid
 * *during* a track, so a row accepted without it pays the track owner instead
 * of the featured artist, with every leg reporting ✓.
 *
 * `null`, `undefined` and `[]` are the only shapes observed to mean "no data",
 * so they are the only ones that pass. Anything else costs one Podcast Index
 * lookup, which is the same price every other refusal in this file pays.
 */
function carriesData(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  if (Array.isArray(raw)) return raw.length > 0;
  return true;
}

/** Seconds since the epoch, matching what `buildEpisode` puts on an Episode. */
function pubDate(raw: unknown): number | undefined {
  const ms = raw instanceof Date
    ? raw.getTime()
    : typeof raw === 'string'
      ? Date.parse(raw)
      : typeof raw === 'number'
        ? raw
        : NaN;
  if (!Number.isFinite(ms)) return undefined;
  // A `number` column could already be seconds, so the magnitude decides which.
  // **The boundary is 1e11, and the units are the trap.** A real seconds epoch
  // is ~1.8e9 and a real millisecond one ~1.8e12, so the split has to sit
  // between them; 1e11 is 1973 read as milliseconds and the year 5138 read as
  // seconds, so no timestamp a podcast feed can carry is ambiguous across it.
  // This shipped as `< 1e6` — five orders of magnitude low — which sent every
  // genuine seconds value down the millisecond branch and divided it again,
  // dating every such track to January 1970. (The comment that stood here read
  // 1e6 as 1970-01-12, which is 1e6 SECONDS; 1e6 milliseconds is 1970-01-01.)
  // `datePublished` is rendered in the row and is also written into
  // `FavoriteEpisode.datePublished`, i.e. into the shared kind:10333 event.
  const secs = Math.abs(ms) < 1e11 ? Math.round(ms) : Math.round(ms / 1000);
  return secs > 0 ? secs : undefined;
}
