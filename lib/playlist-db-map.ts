import type { Episode, ValueBlock, ValueRecipient } from './types';

/**
 * Turning a row of the StableKraft playlist database into what this app pays.
 *
 * **Type-only imports, and it must stay that way** — `npm run check:playlistdb`
 * runs this module under `node --experimental-strip-types`, so the check pins
 * the shipping code rather than a reimplemented copy, which is the exact
 * failure the other check scripts were written against. A type-only import
 * erases; a VALUE import does not resolve at all, because Node's ESM loader
 * wants the `.ts` extension TypeScript omits. That is not a style rule, it is
 * what the whole pin rests on. Same terms as `lib/util.ts`.
 *
 * The database is another application's, reached read-only. Its value blocks
 * happen to use the same field names ours do, which makes a straight cast look
 * correct and is precisely why this file exists: **the shape agreeing is not
 * the shape being valid.** Measured over all 13,783 blocks and 25,477
 * recipients it holds, on 2026-08-29:
 *
 * - **139 blocks are the JSON value `null`.** The column is `not null`, so SQL
 *   reports them present and `WHERE "v4vValue" IS NOT NULL` returns them. A
 *   cast hands `null.recipients` straight to the splitter. This one is real,
 *   present, and the reason the block validator is not optional.
 * - **225 recipients carry `split` as a string of digits** (`"100"`, `"14"`).
 *   Every other one is a proper number; no other spelling occurs at all.
 *   `splitSats` does `Math.max(0, r.split || 0)` and `Math.max` COERCES, so
 *   these already pay correctly — measured, not assumed. Repairing them is
 *   about the runtime value matching the `number` our `ValueRecipient`
 *   promises, which several surfaces format and compare without coercing.
 * - `customKey` / `customValue` arrive as `null` rather than absent. Our type
 *   has them optional, and `JSON.stringify` keeps an explicit `null` while
 *   dropping an `undefined` — so a null would ride into the TLV record.
 *
 * **The strict split test is the one guard here that is defensive rather than
 * observed**, and it is worth its cost because the failure is silent and the
 * data is not ours to freeze. Measured against the real `splitSats`: a
 * `"0x64"` weight is read as **100** and `"1e3"` as **1000** — `Math.max`
 * coerces those too — while `"half"` yields `NaN` shares that serialize as
 * `null`. None of the three occurs today. If one ever does, refusing the block
 * costs one Podcast Index call; accepting it pays the wrong split and says ✓.
 *
 * **Refusal is the safe direction here, and only here.** Everywhere else in
 * this repo over-refusing a value block hides BOOST and costs an artist the
 * payment — but this resolver has a fall-through: a `null` sends the row to
 * Podcast Index, which reads the block from the feed the artist controls. So
 * anything not recognised with certainty returns null rather than a guess.
 */

/** A `split` we are willing to do arithmetic on, or null. */
function weight(raw: unknown): number | null {
  // A string of digits is the database's own spelling for 225 recipients and is
  // unambiguous, so it is accepted — but through an explicit digits test, never
  // `Number(raw)` and never a bare coercion. `splitSats` reaches its weight via
  // `Math.max`, which reads '0x64' as 100 and '1e3' as 1000 rather than
  // rejecting them, so the loose forms have to be refused HERE or they are
  // never refused at all. A weight is the denominator every other recipient's
  // share is divided by.
  const n = typeof raw === 'string' && /^\d{1,9}$/.test(raw.trim())
    ? Number(raw.trim())
    : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  // Weights are integers on the wire. A fractional one is not a rounding
  // problem, it is a document we do not understand.
  return Number.isInteger(n) ? n : null;
}

/** `null` and numbers both become a string or nothing — never a literal null. */
function tlv(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw || undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return undefined;
}

/**
 * One recipient, or null if anything about it is unusable.
 *
 * A null here fails the WHOLE block (see `dbValueBlock`) rather than dropping
 * the recipient: dropping one changes the denominator, so the remaining payees
 * would each quietly receive more than the feed says they should, and nothing
 * on screen would differ.
 */
function recipient(raw: unknown): ValueRecipient | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const address = typeof r.address === 'string' ? r.address.trim() : '';
  if (!address) return null;
  const type = typeof r.type === 'string' && r.type ? r.type : null;
  if (!type) return null;
  const split = weight(r.split);
  if (split === null) return null;
  const out: ValueRecipient = { type, address, split };
  if (typeof r.name === 'string' && r.name) out.name = r.name;
  const customKey = tlv(r.customKey);
  if (customKey) out.customKey = customKey;
  const customValue = tlv(r.customValue);
  if (customValue) out.customValue = customValue;
  if (typeof r.fee === 'boolean') out.fee = r.fee;
  return out;
}

/**
 * The database's `Track.v4vValue` as a `ValueBlock`, or null.
 *
 * Null means "ask Podcast Index instead", never "this track cannot be paid".
 */
export function dbValueBlock(raw: unknown): ValueBlock | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.type !== 'string' || !v.type) return null;
  if (typeof v.method !== 'string' || !v.method) return null;
  if (!Array.isArray(v.recipients) || !v.recipients.length) return null;

  const recipients: ValueRecipient[] = [];
  for (const r of v.recipients) {
    const one = recipient(r);
    if (!one) return null;
    recipients.push(one);
  }
  // Every weight zero is a block that can pay nobody. `splitSats` would hand
  // out nothing and `payOne` would report every leg ok without contacting
  // anyone — the false ✓ that money-boosts.md calls a collaboration between an
  // honest 0 and a short-circuit. Fall through and let the feed answer.
  if (!recipients.some((r) => r.split > 0)) return null;

  const block: ValueBlock = { type: v.type, method: v.method, recipients };
  if (typeof v.suggested === 'string' && v.suggested) block.suggested = v.suggested;
  return block;
}

/** One row of the join, as the database hands it over. */
export interface DbTrackRow {
  itemGuid: unknown;
  feedGuid: unknown;
  title: unknown;
  audioUrl: unknown;
  duration: unknown;
  image: unknown;
  publishedAt: unknown;
  value: unknown;
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
 * `id`, `feedId` and `playlistGroup` are all supplied by the caller. `feedId`
 * is the container's synthetic id, which this module cannot know; `id` is the
 * shared row identity described below; and `playlistGroup` comes from the
 * playlist's own `<podcast:txt>` markers rather than from the database, so the
 * heading a track appears under is always the one the curator wrote.
 */
export function dbRowToEpisode(
  row: DbTrackRow,
  opts: { id: number; feedId: number; playlistGroup?: string },
): Episode | null {
  const guid = typeof row.itemGuid === 'string' ? row.itemGuid : '';
  const enclosureUrl = typeof row.audioUrl === 'string' ? row.audioUrl.trim() : '';
  if (!guid || !enclosureUrl) return null;
  // Anything we would drop sends the whole row to Podcast Index instead.
  if (nonEmpty(row.valueTimeSplits) || nonEmpty(row.alternateEnclosures)) return null;
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
  const value = dbValueBlock(row.value);
  if (value) ep.value = value;
  if (opts.playlistGroup) ep.playlistGroup = opts.playlistGroup;
  return ep;
}

/** True for an array with something in it — the shape both refusals test. */
function nonEmpty(raw: unknown): boolean {
  return Array.isArray(raw) && raw.length > 0;
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
  // A `number` column could already be seconds. Anything below this is not a
  // plausible millisecond timestamp (it is 1970-01-12) and is treated as
  // seconds already, which is the only reading that does not put every track in
  // the 1970s or the year 56000.
  const secs = Math.abs(ms) < 1e6 ? Math.round(ms) : Math.round(ms / 1000);
  return secs > 0 ? secs : undefined;
}
