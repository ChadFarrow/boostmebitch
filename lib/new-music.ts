/**
 * NEW MUSIC — the pure half of the section on /favorites that shows new albums
 * from the artists (publisher feeds) the reader favorited.
 *
 * **An artist is a favorited PUBLISHER FEED** (`<podcast:medium>publisher`), the
 * feed a music host publishes per artist to list that artist's albums as
 * `<podcast:remoteItem>`s. A new album is a NEW FEED, so the NEW EPISODES check
 * — which asks Podcast Index what came out on feeds already in the library —
 * can never see one. The publisher feed is the only document that names it.
 *
 * The flow, and which half lives where:
 *
 * 1. `<FavoritesNewMusic>` reads each favorited publisher feed through
 *    `/api/publisher` (the route the playlists page and the publisher view
 *    already use), which answers with the albums it lists, resolved.
 * 2. `planPublisher` (here) splits that list into what was seen and what was
 *    not, against what this device remembers for that artist.
 * 3. The component asks `/api/new-episodes?latest=1` for each candidate's
 *    newest track, which is the nearest thing an album has to a release date.
 * 4. `selectNewMusic` (here) decides which candidates become rows.
 * 5. `mergeNewMusicRows` (here) folds them into the persisted list.
 *
 * **IMPORT-FREE, and it must stay so**: `scripts/check-newmusic.mjs` loads it
 * under plain Node with `--experimental-strip-types`, and the scan there rejects
 * even a type-only relative import. That is why the album shape below is its
 * own structural type rather than `Podcast` from `lib/types.ts` — a `Podcast`
 * satisfies it.
 */

/**
 * An artist followed with ♡ ARTIST on the album page — on THIS DEVICE ONLY.
 *
 * **Never on the shared kind:10333 list** (the owner's choice, 2026-11-15,
 * until cross-app artist favorites are decided). A feed favorite there is keyed
 * by guid alone and carries no feed URL, so an artist feed Podcast Index does
 * not hold — every Wavlake artist feed, on 2026-11-15 — would be an entry no
 * other device or app can open. Kept in `bmb:artists:<npub>` instead, with the
 * URL, so NEW MUSIC can read the feed without Podcast Index.
 */
export interface ArtistFollow {
  /** The artist feed's guid, as the album's channel names it. */
  feedGuid: string;
  /** The artist feed's address — what NEW MUSIC reads. */
  feedUrl: string;
  /** The artist's name, from the album it was followed on. */
  title?: string;
  /** Unix ms. */
  addedAt: number;
}

/** One artist NEW MUSIC asks about, from either source. */
export interface NewMusicArtist {
  podcastGuid: string;
  url?: string;
  title?: string;
}

/**
 * Every artist NEW MUSIC follows: the publisher feeds in the reader's
 * FAVORITES first, then the ones followed on this device only. One artist in
 * both is one artist (guids compared without case), and the favorite's record
 * wins — it is the one Podcast Index resolved. A follow with no guid or no
 * address is skipped: it cannot be asked about.
 */
export function newMusicArtists(
  publisherFavorites: readonly NewMusicArtist[],
  follows: Readonly<Record<string, ArtistFollow>>,
): NewMusicArtist[] {
  const out: NewMusicArtist[] = [];
  const have = new Set<string>();
  for (const a of publisherFavorites) {
    const k = a.podcastGuid?.trim().toLowerCase();
    if (!k || have.has(k)) continue;
    have.add(k);
    out.push(a);
  }
  for (const f of Object.values(follows)) {
    const k = f.feedGuid?.trim().toLowerCase();
    if (!k || !f.feedUrl || have.has(k)) continue;
    have.add(k);
    const a: NewMusicArtist = { podcastGuid: f.feedGuid, url: f.feedUrl };
    if (f.title) a.title = f.title;
    out.push(a);
  }
  return out;
}

/** The fields of an album this section reads. A `Podcast` satisfies it. */
export interface NewMusicAlbum {
  /** Podcast Index feed id; 0 when PI does not hold the feed (yet). */
  id: number;
  podcastGuid?: string;
  url?: string;
  title: string;
  author?: string;
  image?: string;
  artwork?: string;
  medium?: string;
}

export interface NewMusicRow {
  album: NewMusicAlbum;
  /** The favorited publisher feed's `podcastGuid` — the artist the row is FROM. */
  publisherGuid: string;
  /** The artist's name as the reader's favorite holds it. */
  publisherTitle?: string;
  /** Unix SECONDS: the album's newest track, when Podcast Index could say. */
  date?: number;
  /** Unix MS: the pass that found the row. Orders a row with no `date`. */
  foundAt: number;
}

export interface NewMusicRecord {
  /** Unix ms of the last pass that issued a request — the throttle. */
  checkedAt: number;
  /** Per artist (publisher `podcastGuid`): the album KEYS this device has seen
   *  listed. Absent means the artist has never been read: a FIRST look. */
  seen: Record<string, string[]>;
  /** Per artist: unix ms of the last successful read. Orders the pass. */
  checked: Record<string, number>;
  rows: NewMusicRow[];
  /** Row keys the reader removed (✕ / CLEAR), so a later pass cannot bring
   *  them back. Newest last, capped. */
  dismissed?: string[];
  /** Artists a request was made for that did not come back, last pass. */
  uncovered?: number;
}

/**
 * How far back a "new" album may be. Ninety days, the window the NEW EPISODES
 * first check uses for a show's latest episode (`selectLatestEpisodes`), so the
 * two sections on one page agree about what "new" means.
 */
export const NEW_MUSIC_WINDOW_SECS = 90 * 24 * 60 * 60;
/** Rows kept. A cap on a not-evictable key, not a page size. */
export const NEW_MUSIC_CAP = 100;
/**
 * Album keys kept per artist. Two per album (guid and URL), and `/api/publisher`
 * reads at most 100 albums (`MAX_PUBLISHER_ALBUMS`), so 200 holds every album
 * that route can ever return, twice keyed.
 */
export const NEW_MUSIC_SEEN_CAP = 200;
/** Dismissed row keys kept. */
export const NEW_MUSIC_DISMISSED_CAP = 200;

/**
 * The URL as a key: the host lowercased and one trailing slash dropped, the
 * path left alone — paths are case-sensitive, and two feeds differing only in
 * case are two feeds.
 */
function urlKey(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    const path = u.pathname.length > 1 && u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
    return `${u.protocol}//${u.host.toLowerCase()}${path === '/' ? '' : path}${u.search}`;
  } catch {
    return s.replace(/\/$/, '');
  }
}

/**
 * Every key an album can be recognised by: its guid, then its URL.
 *
 * **BOTH, and a match on either is a match.** Podcast Index answers with a guid
 * and a URL; the RSS fallback `/api/publisher` takes while PI rate limits
 * (`couldNotAskPi`) may carry the URL alone, because a channel need not declare
 * `<podcast:guid>`. Recognising an album by its guid only would re-announce
 * every album of an artist the pass after PI was busy.
 */
export function albumKeys(a: Pick<NewMusicAlbum, 'podcastGuid' | 'url'>): string[] {
  const keys: string[] = [];
  const guid = a.podcastGuid?.trim().toLowerCase();
  if (guid) keys.push(`guid:${guid}`);
  const url = a.url ? urlKey(a.url) : null;
  if (url) keys.push(`url:${url}`);
  return keys;
}

/** A row's one identity: the album's first key. React key and dismiss key. */
export function rowKey(row: Pick<NewMusicRow, 'album'>): string {
  return albumKeys(row.album)[0] ?? `title:${row.album.title}`;
}

/** Keep the newest `n`, a repeat moving to its latest position. */
export function capKeys(keys: readonly string[], n: number): string[] {
  const out: string[] = [];
  const at = new Map<string, number>();
  for (const k of keys) {
    const prev = at.get(k);
    if (prev !== undefined) out[prev] = '';
    at.set(k, out.length);
    out.push(k);
  }
  return out.filter(Boolean).slice(-n);
}

export interface PublisherPlan {
  /** True when this device has never read this artist. */
  first: boolean;
  /**
   * On a first look, EVERY album listed — the candidates for "the artist's
   * latest". On a later look, only the albums not seen before.
   */
  candidates: NewMusicAlbum[];
  /** What `seen` becomes for this artist once the pass is written. */
  nextSeen: string[];
}

/**
 * One artist's listing against what this device has seen of it.
 *
 * **Absent `prevSeen` is a first look; an EMPTY one is not.** A publisher feed
 * read once while it listed nothing has been seen — everything it lists later
 * is new.
 *
 * **A first look marks EVERY listed album seen.** Without that the next pass
 * calls the artist's whole back catalogue new, which is the obvious version and
 * the one `scripts/check-newmusic.mjs` replays as `naive()`. Whether one of
 * them is still shown — the artist's latest — is `selectNewMusic`'s decision,
 * not this one's.
 *
 * Only call this for a publisher feed that was READ. A failed read keeps the
 * artist's `seen` as it was, so nothing it listed is skipped over.
 */
export function planPublisher(prevSeen: readonly string[] | undefined, albums: readonly NewMusicAlbum[]): PublisherPlan {
  const first = prevSeen === undefined;
  const seen = new Set(prevSeen ?? []);
  const candidates: NewMusicAlbum[] = [];
  const added: string[] = [];
  for (const a of albums) {
    const keys = albumKeys(a);
    if (!keys.length) continue;
    const known = keys.some((k) => seen.has(k));
    if (first || !known) candidates.push(a);
    for (const k of keys) if (!seen.has(k)) added.push(k);
  }
  return { first, candidates, nextSeen: capKeys([...(prevSeen ?? []), ...added], NEW_MUSIC_SEEN_CAP) };
}

export interface SelectInput {
  first: boolean;
  candidates: readonly NewMusicAlbum[];
  /** Album PI feed id → unix seconds of its newest track. */
  dates: Readonly<Record<number, number>>;
  nowSec: number;
  /** Every key of every album already in the reader's favorites. */
  favoriteKeys: ReadonlySet<string>;
}

/** The candidates that become rows — without `publisherGuid` or `foundAt`,
 *  which the caller knows and this does not. */
export function selectNewMusic(input: SelectInput): Pick<NewMusicRow, 'album' | 'date'>[] {
  const { first, candidates, dates, nowSec, favoriteKeys } = input;
  const floor = nowSec - NEW_MUSIC_WINDOW_SECS;
  const dateOf = (a: NewMusicAlbum): number | undefined => {
    const d = a.id > 0 ? dates[a.id] : undefined;
    // A date in the future is a feed's typo, not a release; it would win
    // "newest" for ever. A day of slack for clocks.
    return typeof d === 'number' && Number.isFinite(d) && d > 0 && d <= nowSec + 86_400 ? d : undefined;
  };
  const isFavorite = (a: NewMusicAlbum) => albumKeys(a).some((k) => favoriteKeys.has(k));
  const row = (a: NewMusicAlbum, d: number | undefined) => (d === undefined ? { album: a } : { album: a, date: d });

  if (first) {
    /**
     * A FIRST LOOK SHOWS THE ARTIST'S LATEST ALBUM, at most one, and only when
     * it is inside the window — the rule the NEW EPISODES first check follows
     * for a show (the owner's choice there, 2026-10-01). With no dates there is
     * no "latest" to name, so nothing is shown rather than a guess.
     *
     * Newest among ALL listed albums, and only then the favorites test: when
     * the newest is already a favorite, the reader has it, and falling back to
     * the second newest would announce an older album as the news.
     */
    let best: NewMusicAlbum | undefined;
    let bestDate = -1;
    for (const a of candidates) {
      const d = dateOf(a);
      if (d !== undefined && d > bestDate) { best = a; bestDate = d; }
    }
    if (!best || bestDate < floor || isFavorite(best)) return [];
    return [row(best, bestDate)];
  }

  /**
   * A LATER LOOK: every album not seen before, except one that is already a
   * favorite, or one Podcast Index dates outside the window. The last rule is
   * for an artist moving an old catalogue onto a new host, which lists old
   * albums as new feeds. An album with NO date is a row — a new album is often
   * not in Podcast Index yet, and that is the case this section exists for.
   */
  const out: Pick<NewMusicRow, 'album' | 'date'>[] = [];
  for (const a of candidates) {
    if (isFavorite(a)) continue;
    const d = dateOf(a);
    if (d !== undefined && d < floor) continue;
    out.push(row(a, d));
  }
  return out;
}

/** Seconds to order a row by: its date, else when it was found. */
function sortTime(r: NewMusicRow): number {
  return r.date ?? Math.floor(r.foundAt / 1000);
}

/**
 * The stored list with a pass's new rows folded in.
 *
 * A row already stored WINS over the same album found again: its `foundAt` is
 * when the reader could first have seen it. Same album means any shared key.
 * A dismissed key — under either of the album's keys — never comes back.
 * Newest first, capped at `NEW_MUSIC_CAP`, oldest dropped.
 */
export function mergeNewMusicRows(
  stored: readonly NewMusicRow[],
  fresh: readonly NewMusicRow[],
  dismissed: ReadonlySet<string> | undefined,
): NewMusicRow[] {
  const taken = new Set<string>();
  const out: NewMusicRow[] = [];
  for (const r of [...stored, ...fresh]) {
    const keys = albumKeys(r.album);
    const ks = keys.length ? keys : [rowKey(r)];
    if (ks.some((k) => taken.has(k) || dismissed?.has(k))) continue;
    for (const k of ks) taken.add(k);
    out.push(r);
  }
  out.sort((a, b) => sortTime(b) - sortTime(a));
  return out.slice(0, NEW_MUSIC_CAP);
}

/**
 * The record with every artist the reader no longer favorites taken out: its
 * rows, its `seen` and its check time. Dropping `seen` is what makes a
 * re-favorite a first look again rather than a flood of everything released
 * since. Returns a new record; the argument is not changed.
 */
export function pruneNewMusic(record: NewMusicRecord, publisherGuids: readonly string[]): NewMusicRecord {
  const keep = new Set(publisherGuids);
  const pick = <T>(m: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(m)) if (keep.has(k)) out[k] = v;
    return out;
  };
  return {
    ...record,
    seen: pick(record.seen),
    checked: pick(record.checked),
    rows: record.rows.filter((r) => keep.has(r.publisherGuid)),
  };
}

/**
 * Artists in the order a pass asks about them: never read first, then the
 * oldest read. A pass has a ceiling, and this order makes the next pass cover
 * what this one did not. Stable among equals.
 */
export function stalestFirst(guids: readonly string[], checked: Readonly<Record<string, number>>): string[] {
  return guids
    .map((g, i) => ({ g, i, t: checked[g] ?? 0 }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.g);
}
