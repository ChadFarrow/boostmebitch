/**
 * The favorites library as a downloadable JSON document.
 *
 * Pure: it builds an object and a filename, and touches no DOM. The Blob and
 * the `<a download>` live in `components/favorites-page.tsx`, which is the one
 * consumer.
 *
 * Three properties this file exists to hold, none of them obvious from a
 * `JSON.stringify(favorites)`:
 *
 *  - **It carries the NIP-73 identifier, not just the render fields.** The
 *    favorite IS the guid — `title`, `image` and `author` are what Podcast
 *    Index happened to answer, and an unresolved entry has none of them. A
 *    dump of the store maps alone would write rows another app cannot open,
 *    and would look empty for exactly the independent releases this app
 *    exists to pay. `showId`/`itemId` are the same helpers the kind:10333
 *    writer uses, so the file names each favorite the way the shared list
 *    does.
 *  - **It states how complete it is, in the file — and that is TWO questions,
 *    not one.** `complete` answers membership: is every favorite on the list
 *    here. `counts.unresolved*` answers description: how many of them Podcast
 *    Index has put a title on. They settle at different times and the gap is
 *    wide, because `favoritesSync` reaches `'ok'` as soon as the relay read is
 *    trusted — before the resolve passes in `favorites-hydrator.ts` write a
 *    single title back. A download in that window is a complete list of bare
 *    guids, and shipping only `complete` printed "the full favorites list"
 *    over 286 rows of nulls on a real account. Both travel with the data,
 *    because the person who opens the file a month later has no
 *    `<FavoritesSyncNotice>` and no favorites page on screen to tell them
 *    which of the two they are looking at.
 *  - **`addedAt: 0` becomes `null`.** Zero means "not known yet" in the store,
 *    never "1 January 1970"; writing the epoch into a dated field invents a
 *    fact, and a reader sorting by it would bury every unresolved entry.
 *
 * It deliberately does NOT read a wallet, a signer, or any `bmb:*` key beyond
 * the two favorites maps the caller passes in. The npub is public and is here
 * so a file can be told from another account's; nothing secret may ever join
 * it, because this writes to the user's disk and travels off the device.
 */
import { BRAND } from '@/lib/brand';
import { itemId, showId } from '@/lib/nostr/favorites-list';
import type { FavoriteEpisode, FavoritePodcast } from '@/lib/types';
import type { FavoritesSyncStatus } from '@/lib/store';

/** Bumped only when a reader would break. Additive fields do not bump it. */
export const FAVORITES_EXPORT_VERSION = 1;

/**
 * Brand-neutral, and that is on purpose: one repo builds two deploys, and a
 * `format` naming one of them would make the other's file look like a
 * different document to any reader that switches on this string.
 */
export const FAVORITES_EXPORT_FORMAT = 'pc20-favorites';

export interface ExportedFeedFavorite {
  /** NIP-73 `podcast:guid:<guid>` — how the kind:10333 list names this feed. */
  id: string;
  podcastGuid: string;
  title: string | null;
  author: string | null;
  /** `<podcast:medium>` as the FEED declared it. `null` means nobody said. */
  medium: string | null;
  feedUrl: string | null;
  image: string | null;
  /** ISO 8601, or `null` when the store never learned one. */
  addedAt: string | null;
}

export interface ExportedItemFavorite {
  /** NIP-73 `podcast:item:guid:<guid>`. */
  id: string;
  itemGuid: string;
  /** The parent feed's guid. `null` makes the item unresolvable, not invalid. */
  feedGuid: string | null;
  title: string | null;
  podcastTitle: string | null;
  medium: string | null;
  feedUrl: string | null;
  enclosureUrl: string | null;
  datePublished: string | null;
  addedAt: string | null;
}

export interface FavoritesExport {
  format: typeof FAVORITES_EXPORT_FORMAT;
  version: number;
  /** Which deploy wrote it. Per-brand, never a hard-coded name. */
  app: string;
  /** The account these favorites belong to, or `null` when signed out. */
  npub: string | null;
  exportedAt: string;
  /** The relay-sync state at the moment of the download. */
  sync: FavoritesSyncStatus;
  /** False whenever the app could not confirm it holds the whole library. */
  complete: boolean;
  /** One sentence saying what the file is, in the reader's own words. */
  note: string;
  /**
   * `unresolved*` counts the entries carrying no title.
   *
   * They are here because a file of nulls reads as a broken export and is not
   * one — and because `complete` cannot answer it. `complete` is about
   * MEMBERSHIP: is every favorite on the list in this file. Whether a row has
   * a title is a different question with a different owner, Podcast Index,
   * and the two settle at different times: `favoritesSync` reaches `'ok'` the
   * moment the relay read is trusted, which is BEFORE the resolve passes in
   * `lib/nostr/favorites-hydrator.ts` have written a single title back. A
   * download taken in that window is a complete list of bare guids, and the
   * first version of this file called it "the full favorites list" and said
   * nothing else. Reported from a real account: 286 of 286.
   */
  counts: {
    feeds: number;
    items: number;
    unresolvedFeeds: number;
    unresolvedItems: number;
  };
  feeds: ExportedFeedFavorite[];
  items: ExportedItemFavorite[];
}

export interface FavoritesExportInput {
  feeds: FavoritePodcast[];
  items: FavoriteEpisode[];
  npub: string | null;
  sync: FavoritesSyncStatus;
  /** Injected so the caller can pin a timestamp; defaults to now. */
  now?: number;
}

/**
 * Is this snapshot the whole library?
 *
 * Signed OUT is complete: favorites are local with no key to sync them under,
 * so this device holds all there is and an honest file can say so. Signed in,
 * only a settled read may claim it — `'idle'` and `'loading'` both mean the
 * relay read has not answered, which is the same pair `<FavoritesPage>` refuses
 * to call an empty library. `'off'` counts as complete because the user chose
 * device-only storage; the note says so rather than the flag lying about it.
 */
export function exportIsComplete(npub: string | null, sync: FavoritesSyncStatus): boolean {
  if (!npub) return true;
  return sync === 'ok' || sync === 'off';
}

/**
 * The sentence that travels with the file. Never contradicts `complete`.
 *
 * Two clauses, and they answer two different questions on purpose: where the
 * LIST came from, then how much of it Podcast Index has described. Nothing on
 * the reader's screen distinguishes "this favorite is missing" from "this
 * favorite has no title yet", and the second is the ordinary state on a device
 * that has just adopted a list off the relays.
 */
export function exportNote(
  npub: string | null,
  sync: FavoritesSyncStatus,
  unresolved = 0,
  total = 0,
): string {
  return [membershipClause(npub, sync), resolutionClause(unresolved, total)]
    .filter(Boolean)
    .join(' ');
}

/**
 * How many rows carry no title, and what that does and does not mean.
 *
 * Empty when everything resolved — a file with nothing to explain should not
 * carry a paragraph explaining it. The last sentence is the load-bearing one:
 * an unresolved entry is COMPLETE, because the guid is the favorite and the
 * title is metadata. Without it the count reads as data loss.
 */
function resolutionClause(unresolved: number, total: number): string {
  if (unresolved <= 0) return '';
  return `${unresolved} of ${total} entries carry no title: Podcast Index had not resolved them on this device when the file was written, or does not index them at all. Those entries are still complete — the guid is the favorite and the title is metadata that fills in later.`;
}

function membershipClause(npub: string | null, sync: FavoritesSyncStatus): string {
  if (!npub) {
    return 'Saved on this device only. No Nostr account was signed in when this file was written.';
  }
  if (sync === 'degraded') {
    return 'Incomplete: the favorites list could not be read from the relays, so anything saved in another app or on another device is missing from this file.';
  }
  if (sync === 'idle' || sync === 'loading') {
    return 'Incomplete: the relay read had not finished when this file was written, so it holds only what this device had already loaded.';
  }
  if (sync === 'off') {
    return 'Favorites are set to stay on this device, so this file holds no entries saved in another app.';
  }
  return 'Every favorite on the list, merged with the shared list on the Nostr relays.';
}

/** unix ms → ISO 8601. `0` is "not known yet" and stays absent. */
function isoOrNull(ms: number | undefined): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

function feedRow(f: FavoritePodcast): ExportedFeedFavorite {
  return {
    id: showId(f.podcastGuid),
    podcastGuid: f.podcastGuid,
    title: f.title ?? null,
    author: f.author ?? null,
    medium: f.medium ?? null,
    feedUrl: f.url ?? null,
    image: f.image ?? f.artwork ?? null,
    addedAt: isoOrNull(f.addedAt),
  };
}

function itemRow(e: FavoriteEpisode): ExportedItemFavorite {
  return {
    id: itemId(e.itemGuid),
    itemGuid: e.itemGuid,
    feedGuid: e.feedGuid ?? null,
    title: e.title ?? null,
    podcastTitle: e.podcastTitle ?? null,
    medium: e.medium ?? null,
    feedUrl: e.feedUrl ?? null,
    enclosureUrl: e.enclosureUrl ?? null,
    datePublished: isoOrNull(e.datePublished ? e.datePublished * 1000 : undefined),
    addedAt: isoOrNull(e.addedAt),
  };
}

/**
 * Build the document.
 *
 * Rows go out in the order handed in — the caller passes the STORE maps, not
 * the filtered view, because a file named "my favorites" that silently held
 * whatever tab was open is the same class of lie as a count that shrinks to
 * match the visible slice.
 */
export function buildFavoritesExport(input: FavoritesExportInput): FavoritesExport {
  const { feeds, items, npub, sync } = input;
  const feedRows = feeds.map(feedRow);
  const itemRows = items.map(itemRow);
  // Counted off the EXPORTED rows, not the store entries, so the number can
  // never disagree with the nulls a reader is looking at.
  const unresolvedFeeds = feedRows.filter((r) => !r.title).length;
  const unresolvedItems = itemRows.filter((r) => !r.title).length;
  return {
    format: FAVORITES_EXPORT_FORMAT,
    version: FAVORITES_EXPORT_VERSION,
    app: BRAND.wireName,
    npub,
    exportedAt: new Date(input.now ?? Date.now()).toISOString(),
    sync,
    complete: exportIsComplete(npub, sync),
    note: exportNote(
      npub,
      sync,
      unresolvedFeeds + unresolvedItems,
      feedRows.length + itemRows.length,
    ),
    counts: {
      feeds: feedRows.length,
      items: itemRows.length,
      unresolvedFeeds,
      unresolvedItems,
    },
    feeds: feedRows,
    items: itemRows,
  };
}

/**
 * `boostmebitch-favorites-2026-09-01.json`.
 *
 * The first label of `BRAND.domain`, so the two deploys write distinguishable
 * files and neither hard-codes the other's word. A local date, deliberately:
 * the file lands in a folder a person browses, and a UTC stamp names yesterday
 * for anyone west of Greenwich in the evening.
 */
export function favoritesExportFilename(now: number = Date.now()): string {
  const site = BRAND.domain.split('.')[0];
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${site}-favorites-${stamp}.json`;
}
