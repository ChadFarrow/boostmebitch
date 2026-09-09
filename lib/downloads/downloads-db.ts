import type { Episode, Podcast, ValueBlock, ValueTimeSplit } from '../types';

/**
 * The metadata half of a download. The bytes live in the Cache API
 * (`downloads-cache.ts`); this is everything needed to render a row, rebuild a
 * real {@link Episode} and hand it to `play()`.
 *
 * WHY ITS OWN DATABASE, AND NOT `bmb:*` localStorage. A `DownloadRecord` can
 * carry a whole value block and a `valueTimeSplits` array, and there can be
 * hundreds of them; localStorage is a few megabytes for the entire origin and
 * `safeSet`'s eviction ladder would be actively wrong here — evicting a
 * download's metadata orphans real bytes on disk. It is also a deliberate
 * SIBLING of anything else this app stores, so a future version bump elsewhere
 * can never take the download library with it.
 *
 * PERSISTENCE INVARIANT: `DB_NAME`, `DB_VERSION` and `STORE` are on-disk
 * identifiers. Renaming any of them does not migrate anything — it points the
 * app at a database nothing ever wrote, so every existing download reads back as
 * never having existed while its bytes sit in the cache, unreachable and
 * uncountable. `DB_VERSION` may only be raised with an ADDITIVE
 * `onupgradeneeded`; never `deleteObjectStore`. Adding a field to
 * `DownloadRecord` needs no bump at all, because IndexedDB stores whole objects.
 */
const DB_NAME = 'BmbDownloadsDB';
const DB_VERSION = 1;
const STORE = 'downloads';

export interface DownloadRecord {
  /** `downloadKey(enclosureUrl)` — also the Cache API key for the bytes. */
  key: string;
  /** The URL the bytes came from, kept so a row can fall back to streaming. */
  enclosureUrl: string;
  enclosureType?: string;
  sizeBytes: number;
  createdAt: number;

  // --- enough to rebuild an Episode + Podcast and play it -------------------
  itemGuid?: string;
  /**
   * The item's OWN parent feed guid, never the guid of whatever feed listed it.
   *
   * A `musicL` playlist lists tracks that live in hundreds of other feeds, so
   * copying the container's guid here would record a fact about the playlist as
   * a fact about the track — and this field is what a boost from the downloads
   * page resolves its payee against. `containerIsParent` in the component that
   * creates the record is the discriminator; see the note on
   * `<FavEpisodeHeart>`, which is under the identical rule.
   */
  feedGuid?: string;
  feedId?: number;
  title: string;
  feedTitle?: string;
  image?: string;
  feedImage?: string;
  duration?: number;
  datePublished?: number;

  /**
   * The value block as it stood when the download was taken.
   *
   * Carried so a download can still be boosted. It is a CACHE of the feed's
   * splits and never outranks a live read: `payableValue` reads `episode.value`
   * first, so a record handed back into an `Episode` must be handed back whole
   * or not at all — see `dbRowToEpisode`'s note.
   */
  value?: ValueBlock | null;
  valueTimeSplits?: ValueTimeSplit[];

  // --- phase 5, and small enough to sit in the record ------------------------
  chaptersJson?: string;
  transcriptText?: string;
  transcriptType?: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
        /**
         * NO INDEXES, DELIBERATELY. The manager reads every record into memory
         * once (`hydrate`) and answers both lookups — by key and by item guid —
         * from Maps, because the by-guid one sits in front of `el.src = …` and
         * an IndexedDB round trip there would delay the start of every episode.
         *
         * An index would be a second mechanism answering a question already
         * answered. If the library ever grows past what is sensible to hold in
         * memory, add one here with a `DB_VERSION` bump — additively, never by
         * recreating the store.
         */
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    // A second tab holding an older version open blocks the upgrade. Failing
    // loudly beats hanging forever behind a promise nothing settles.
    req.onblocked = () => reject(new Error('indexedDB upgrade blocked by another tab'));
  });
  // A failed open must not be memoised, or one transient failure disables
  // downloads for the life of the tab.
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(STORE, mode);
  return promisify(fn(tx.objectStore(STORE)));
}

export async function putRecord(record: DownloadRecord): Promise<void> {
  await withStore('readwrite', (s) => s.put(record));
}

export async function getRecord(key: string): Promise<DownloadRecord | null> {
  return (await withStore<DownloadRecord | undefined>('readonly', (s) => s.get(key))) ?? null;
}

export async function getAllRecords(): Promise<DownloadRecord[]> {
  return (await withStore<DownloadRecord[]>('readonly', (s) => s.getAll())) ?? [];
}

export async function deleteRecord(key: string): Promise<void> {
  await withStore('readwrite', (s) => s.delete(key));
}

export async function clearAllRecords(): Promise<void> {
  await withStore('readwrite', (s) => s.clear());
}

/**
 * Rebuild a playable {@link Episode} from a record.
 *
 * `enclosureUrl` is the ORIGINAL network URL, not the blob URL: resolving the
 * local bytes is the player's job, and it has a fallback path for an evicted
 * download that only works if the network URL is still here.
 *
 * `id` and `feedId` are synthesised from what the record has. Nothing keys off
 * `id` except React, and `feedId` is only a Podcast Index hint.
 */
export function dbRowToEpisode(r: DownloadRecord): Episode {
  return {
    id: r.feedId ?? 0,
    guid: r.itemGuid,
    title: r.title,
    enclosureUrl: r.enclosureUrl,
    enclosureType: r.enclosureType,
    duration: r.duration,
    datePublished: r.datePublished,
    image: r.image,
    feedId: r.feedId ?? 0,
    feedTitle: r.feedTitle,
    feedImage: r.feedImage,
    podcastGuid: r.feedGuid,
    value: r.value,
    valueTimeSplits: r.valueTimeSplits,
  };
}

/**
 * The minimal {@link Podcast} that goes with it.
 *
 * `value` is deliberately left undefined rather than copied from the episode.
 * The episode's block is the one the record actually captured; duplicating it
 * onto the podcast would make `e.value ?? podcast.value` (the server-side
 * fallback in `app/api/feed/route.ts`) answer from a second copy that no feed
 * ever stated.
 */
export function dbRowToPodcast(r: DownloadRecord): Podcast {
  return {
    id: r.feedId ?? 0,
    podcastGuid: r.feedGuid,
    title: r.feedTitle ?? r.title,
    image: r.feedImage,
    artwork: r.feedImage,
  };
}
