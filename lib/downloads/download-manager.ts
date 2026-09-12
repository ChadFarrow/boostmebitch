import { artCandidates } from '../util';
import type { Episode, Podcast } from '../types';
import { chaptersRequestUrl, downloadKey, isDownloadable, transcriptRequestUrl } from './download-rules';
import * as cache from './downloads-cache';
import * as db from './downloads-db';
import type { DownloadRecord } from './downloads-db';

/**
 * The downloads engine: one module singleton, read through
 * `useSyncExternalStore`.
 *
 * NOT THE ZUSTAND STORE. `lib/store.ts` is documented as in-memory only and is
 * rebuilt on every reload and every Fast Refresh; a download is bytes on a disk
 * that outlive both. Keeping the two apart also means a download in flight is
 * not a render dependency of the player.
 *
 * ONE AT A TIME, DELIBERATELY. StableKraft runs three. This feature exists for a
 * connection too thin to stream on, and on that connection three parallel
 * downloads starve the episode the listener is currently playing — turning the
 * fix into the symptom. A queue, not a pool.
 */

export type DownloadStatus = 'idle' | 'queued' | 'downloading' | 'downloaded' | 'error';

export interface DownloadState {
  status: DownloadStatus;
  /** 0..1 while downloading, when the host sent a `Content-Length`. */
  fraction: number | null;
  /** Written to be shown to a person, not logged. */
  error?: string;
}

const IDLE: DownloadState = { status: 'idle', fraction: null };

/**
 * The storage surface, injected so `scripts/e2e-downloads.mjs` can drive the
 * engine against a fake — no Cache API, no IndexedDB, no network.
 *
 * **A `check:*` script cannot reach it**, and that is a property of this module
 * rather than an oversight: it imports `../util`, which plain Node cannot
 * resolve without an extension, so it will not load under
 * `--experimental-strip-types`. That is exactly why the decisions worth pinning
 * live in `download-rules.ts`, which is import-free, and why this file holds
 * orchestration only. Anything here that starts to look like a rule belongs
 * down there.
 */
export interface DownloadsBackend {
  downloadBytes: typeof cache.downloadBytes;
  deleteBytes: typeof cache.deleteBytes;
  getObjectUrl: typeof cache.getObjectUrl;
  clearAllBytes: typeof cache.clearAllBytes;
  downloadImage: typeof cache.downloadImage;
  getImageObjectUrl: typeof cache.getImageObjectUrl;
  deleteImage: typeof cache.deleteImage;
  cacheDoc: typeof cache.cacheDoc;
  deleteDocs: typeof cache.deleteDocs;
  requestPersistence: typeof cache.requestPersistence;
  putRecord: typeof db.putRecord;
  getAllRecords: typeof db.getAllRecords;
  deleteRecord: typeof db.deleteRecord;
  clearAllRecords: typeof db.clearAllRecords;
}

const realBackend: DownloadsBackend = {
  downloadBytes: cache.downloadBytes,
  deleteBytes: cache.deleteBytes,
  getObjectUrl: cache.getObjectUrl,
  clearAllBytes: cache.clearAllBytes,
  downloadImage: cache.downloadImage,
  getImageObjectUrl: cache.getImageObjectUrl,
  deleteImage: cache.deleteImage,
  cacheDoc: cache.cacheDoc,
  deleteDocs: cache.deleteDocs,
  requestPersistence: cache.requestPersistence,
  putRecord: db.putRecord,
  getAllRecords: db.getAllRecords,
  deleteRecord: db.deleteRecord,
  clearAllRecords: db.clearAllRecords,
};

export class DownloadManager {
  private backend: DownloadsBackend;
  private records = new Map<string, DownloadRecord>();
  /**
   * itemGuid -> key. The second-chance lookup, held in memory because it sits
   * in front of `el.src = …` and an IndexedDB round trip there would delay the
   * start of every episode, downloaded or not.
   */
  private byItemGuid = new Map<string, string>();
  private states = new Map<string, DownloadState>();
  private controllers = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  private version = 0;
  private hydrated = false;
  private hydrating: Promise<void> | null = null;
  private queue: Array<() => void> = [];
  private busy = false;
  private persistenceAsked = false;

  constructor(backend: DownloadsBackend = realBackend) {
    this.backend = backend;
  }

  // --- the useSyncExternalStore surface -------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    // Hydrating on first subscribe rather than at module load keeps IndexedDB
    // off the critical path of a cold page, and means nothing runs on a server
    // render.
    void this.hydrate();
    return () => { this.listeners.delete(fn); };
  };

  getVersion = (): number => this.version;

  private bump() {
    this.version += 1;
    for (const fn of this.listeners) fn();
  }

  /**
   * False until the IndexedDB read has landed.
   *
   * A surface MUST gate its empty copy on this. `<FavoritesPage>` shipped saying
   * "Nothing saved yet." over a full library because it had no in-flight state,
   * and it self-corrected a moment later, which is what made it worse: the
   * listener sees a claim that their library is empty and then watches it fill.
   */
  ready = (): boolean => this.hydrated;

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    if (this.hydrating) return this.hydrating;
    this.hydrating = (async () => {
      try {
        for (const r of await this.backend.getAllRecords()) this.remember(r);
      } catch {
        // No IndexedDB, or a blocked upgrade. An empty library is the honest
        // answer; `ready()` still flips so no surface hangs on "loading".
      }
      this.hydrated = true;
      this.hydrating = null;
      this.bump();
    })();
    return this.hydrating;
  }

  // --- reading ---------------------------------------------------------------

  keyFor(episode: Episode | null | undefined): string | null {
    return downloadKey(episode?.enclosureUrl);
  }

  canDownload(episode: Episode | null | undefined): boolean {
    if (!episode) return false;
    return isDownloadable(episode.enclosureUrl, episode.liveStatus);
  }

  getState(key: string | null | undefined): DownloadState {
    if (!key) return IDLE;
    const live = this.states.get(key);
    if (live) return live;
    return this.records.has(key) ? { status: 'downloaded', fraction: 1 } : IDLE;
  }

  /**
   * The key this episode's download is actually FILED UNDER, which is not
   * always the key its current `enclosureUrl` derives.
   *
   * Every episode-shaped question has to ask it this way. `recordFor` falls
   * back to the item guid precisely because an episode object is enriched in
   * place — `syncSelectedPodcast` and the `/api/feed` backfill both do it — so
   * the same episode can arrive with a new URL and therefore a new derived key.
   * `localKeyFor` already went through `recordFor`; `getEpisodeState` and
   * `download` went through `keyFor` alone, and the two answers disagreed on
   * exactly the case the fallback exists for: `<Player>` played the local bytes
   * while the button rendered `idle`, and a press downloaded the same audio a
   * second time under a second key. That is the failure `downloadKey`'s
   * idempotence rule is written against — the listener pays for the file again,
   * on the connection they downloaded it to avoid.
   *
   * Falls back to the derived key when nothing is stored, so a first download
   * is filed under the URL it was actually fetched from.
   *
   * Public because a SURFACE needs it too, not only this class: a control that
   * reads `getEpisodeState` and then acts on `keyFor` is holding a status and a
   * key that can name two different records, so its ✓ removes nothing. The one
   * answer feeds both.
   */
  storedKeyFor(episode: Episode | null | undefined): string | null {
    if (!episode) return null;
    return this.recordFor(episode)?.key ?? this.keyFor(episode);
  }

  getEpisodeState(episode: Episode | null | undefined): DownloadState {
    return this.getState(this.storedKeyFor(episode));
  }

  /** Newest first — the order `/downloads` renders. */
  listDownloads(): DownloadRecord[] {
    return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * A blob URL for a download's stored cover, or `null`.
   *
   * **The caller owns revoking it**, same as `objectUrlFor`. Used by
   * `/downloads`, which is the one surface that has to render art with no
   * network — every other cover in the app goes through `/api/art`.
   */
  async coverUrlFor(key: string): Promise<string | null> {
    return this.backend.getImageObjectUrl(key);
  }

  /** What is actually stored for this key, or `null` if nothing is. */
  recordSize(key: string): number | null {
    return this.records.get(key)?.sizeBytes ?? null;
  }

  totalBytes(): number {
    let total = 0;
    for (const r of this.records.values()) total += r.sizeBytes || 0;
    return total;
  }

  // --- writing ---------------------------------------------------------------

  async download(episode: Episode, podcast?: Podcast | null): Promise<boolean> {
    // `storedKeyFor`, not `keyFor` — see the note on it. An episode whose
    // enclosure URL moved is already downloaded under the old key, and asking
    // the URL alone would fetch the whole file again.
    const key = this.storedKeyFor(episode);
    if (!key || !this.canDownload(episode)) return false;
    if (this.records.has(key)) return true;
    const existing = this.states.get(key)?.status;
    if (existing === 'queued' || existing === 'downloading') return true;

    // Created BEFORE the queue slot is acquired, so cancelling something that is
    // still waiting is honoured and never issues a fetch.
    const controller = new AbortController();
    this.controllers.set(key, controller);
    this.setState(key, { status: 'queued', fraction: null });

    try {
      await this.acquire();
      if (controller.signal.aborted) throw abortError();
      this.setState(key, { status: 'downloading', fraction: null });
      await this.run(key, episode, podcast ?? null, controller.signal);
      return true;
    } catch (e) {
      if (isAbort(e)) {
        // The user cancelled. Not an error state — back to idle, so the button
        // reads as something they can press again.
        this.setState(key, null);
        return false;
      }
      this.setState(key, { status: 'error', fraction: null, error: messageFor(e) });
      return false;
    } finally {
      this.controllers.delete(key);
      this.release();
    }
  }

  private async run(
    key: string,
    episode: Episode,
    podcast: Podcast | null,
    signal: AbortSignal,
  ): Promise<void> {
    const sizeBytes = await this.backend.downloadBytes(key, {
      sourceUrl: episode.enclosureUrl,
      // The feed's own `<enclosure length>`, which is a HINT: absent or plainly
      // wrong on plenty of feeds. It buys a room check BEFORE the request goes
      // out; `downloadBytes` re-runs it against the real `Content-Length` when
      // the headers arrive, which is still ahead of any of the body.
      expectedBytes: episode.enclosureLength ?? null,
      signal,
      onProgress: (p) => this.setState(key, { status: 'downloading', fraction: p.fraction }),
    });

    const { feedGuid, containerIsParent } = parentFeed(episode, podcast);
    const record: DownloadRecord = {
      key,
      enclosureUrl: episode.enclosureUrl,
      enclosureType: episode.enclosureType,
      sizeBytes,
      createdAt: Date.now(),
      itemGuid: episode.guid,
      feedGuid,
      feedId: episode.feedId,
      title: episode.title,
      // The container's title and art are withheld unless it really is the
      // parent — see `parentFeed`. `episode.*` first either way.
      feedTitle: episode.feedTitle ?? (containerIsParent ? podcast?.title : undefined),
      image: episode.image,
      feedImage: episode.feedImage
        ?? (containerIsParent ? podcast?.image ?? podcast?.artwork : undefined),
      duration: episode.duration,
      datePublished: episode.datePublished,
      enclosureLength: episode.enclosureLength,
      value: episode.value,
      valueTimeSplits: episode.valueTimeSplits,
      chaptersUrl: episode.chaptersUrl,
      transcriptUrl: episode.transcriptUrl,
      transcriptType: episode.transcriptType,
    };

    await this.backend.putRecord(record);
    this.remember(record);
    this.setState(key, null);

    // Chapters, the transcript and the cover are EXTRAS: each is fetched after
    // the audio is already stored and the record already written, so a failure
    // here cannot turn a successful download into a failed one. They are also
    // small — kilobytes against a hundred-odd megabytes — which is why they are
    // taken unconditionally rather than behind a setting.
    const docs = await Promise.all(
      [chaptersRequestUrl(episode.chaptersUrl), transcriptRequestUrl(episode.transcriptUrl, episode.transcriptType)]
        .filter((u): u is string => !!u)
        .map((u) => this.backend.cacheDoc(u)),
    );
    const docKeys = docs.filter((u): u is string => !!u);
    if (docKeys.length) {
      record.docKeys = docKeys;
      await this.backend.putRecord(record).catch(() => {});
      this.remember(record);
    }

    // Art is a nicety and never blocks the download reporting success.
    //
    // It MUST be the `/api/art` copy, which is same-origin: a cross-origin image
    // fetch yields an opaque response, and an opaque response can never become a
    // blob URL — it would store bytes that read back empty. `artCandidates`
    // puts the proxied URLs first and the raw ones behind them, so the raw tail
    // is skipped here rather than cached uselessly.
    // EVERY proxied candidate, in order, not just the first. `artCandidates`
    // puts the proxied URLs ahead of the raw ones; the raw tail is dropped here
    // because a cross-origin image fetch is opaque and would store bytes that
    // read back empty.
    const proxied = artCandidates(record.image, record.feedImage, 640)
      .filter((u) => u.startsWith('/api/art'));
    if (proxied.length) void this.backend.downloadImage(key, proxied);

    // Asked once, lazily, after something is actually worth persisting.
    if (!this.persistenceAsked) {
      this.persistenceAsked = true;
      void this.backend.requestPersistence();
    }
  }

  async cancel(key: string): Promise<void> {
    this.controllers.get(key)?.abort();
  }

  async remove(key: string): Promise<void> {
    this.controllers.get(key)?.abort();
    // Read BEFORE forgetting — `forget` is what drops the record holding them.
    const docKeys = this.records.get(key)?.docKeys ?? [];
    this.forget(key);
    this.setState(key, null);
    await Promise.all([
      this.backend.deleteRecord(key).catch(() => {}),
      this.backend.deleteBytes(key).catch(() => {}),
      this.backend.deleteImage(key).catch(() => {}),
      // Not ref-counted. Two episodes sharing a chapters URL is not a thing
      // feeds do, and the cost of being wrong is one re-fetch of a few
      // kilobytes — where ref-counting would be a second bookkeeping structure
      // to keep in step with the first.
      this.backend.deleteDocs(docKeys).catch(() => {}),
    ]);
    this.bump();
  }

  async clearAll(): Promise<void> {
    for (const c of this.controllers.values()) c.abort();
    this.records.clear();
    this.byItemGuid.clear();
    this.states.clear();
    await Promise.all([
      this.backend.clearAllRecords().catch(() => {}),
      this.backend.clearAllBytes().catch(() => {}),
    ]);
    this.bump();
  }

  /**
   * The eviction self-heal. iOS drops an origin's storage under pressure with no
   * notification, so a record whose bytes are gone is an ordinary state, not a
   * bug. Forget it and let the caller stream.
   */
  async forgetEvicted(key: string): Promise<void> {
    this.forget(key);
    this.states.delete(key);
    await this.backend.deleteRecord(key).catch(() => {});
    this.bump();
  }

  /**
   * Which stored record, if any, holds this episode's bytes. Synchronous, once
   * hydrated.
   *
   * TWO LOOKUPS, and the second is the one that is easy to leave out.
   * `<Player>`'s src effect documents the case in its own comment: an episode
   * object can be **enriched in place** and arrive with a NEW `enclosureUrl` on
   * the same id — a feed moving CDN, or gaining an analytics wrapper. A
   * URL-derived key alone reads that as a different episode and streams over a
   * download the listener already has.
   */
  private recordFor(episode: Episode): DownloadRecord | null {
    const key = this.keyFor(episode);
    if (key) {
      const byKey = this.records.get(key);
      if (byKey) return byKey;
    }
    if (!episode.guid) return null;
    const viaGuid = this.byItemGuid.get(episode.guid);
    return (viaGuid && this.records.get(viaGuid)) || null;
  }

  /**
   * Is there a download for this episode? Answered **synchronously**, so the
   * player can keep its source assignment on the same tick as the tap.
   *
   * Three values, and the third is the point:
   * - a `string` — the record key. Local bytes exist; resolving them is async.
   * - `null` — definitely not downloaded.
   * - `undefined` — **not known yet**, because hydration has not landed. The
   *   caller must not read this as "no", which is the same mistake
   *   `<FavoritesPage>` made about an empty library.
   *
   * WHY THIS EXISTS RATHER THAN JUST AWAITING `resolveSource`. iOS ties
   * `play()` to the user gesture, and an `await` over real I/O can lose it, so
   * an episode with no download must reach `el.src = …` without one. Keeping
   * that path synchronous means this feature cannot regress ordinary playback
   * for someone who has never pressed download.
   */
  localKeyFor(episode: Episode | null | undefined): string | null | undefined {
    if (!episode) return null;
    if (!this.hydrated) return undefined;
    return this.recordFor(episode)?.key ?? null;
  }

  /**
   * The blob URL for a stored download, or `null` if its bytes are gone.
   *
   * Takes the KEY rather than the episode, because the caller has already
   * decided there is something to fetch — see {@link localKeyFor}.
   *
   * **The caller owns revoking the URL.**
   */
  async objectUrlFor(key: string): Promise<string | null> {
    const url = await this.backend.getObjectUrl(key);
    if (url) return url;
    // The bytes are gone but the record is not: iOS evicted them. Forget it and
    // let the caller stream, which is what they had before pressing download.
    await this.forgetEvicted(key);
    return null;
  }

  /**
   * The blob URL for this episode's local bytes, or `null` — awaiting hydration
   * first. For a caller that is not on the playback critical path.
   */
  async resolveSource(episode: Episode | null | undefined): Promise<string | null> {
    if (!episode) return null;
    await this.hydrate();
    const record = this.recordFor(episode);
    return record ? this.objectUrlFor(record.key) : null;
  }

  // --- the one-at-a-time queue ----------------------------------------------

  private acquire(): Promise<void> {
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  private release() {
    const next = this.queue.shift();
    if (next) next();
    else this.busy = false;
  }

  /**
   * The ONE place a record enters memory, so `records` and `byItemGuid` cannot
   * drift. A guid map built anywhere else is a lookup that answers correctly
   * until the day something is removed.
   */
  private remember(r: DownloadRecord) {
    this.records.set(r.key, r);
    if (r.itemGuid) this.byItemGuid.set(r.itemGuid, r.key);
  }

  /** ...and the one place it leaves. */
  private forget(key: string) {
    const r = this.records.get(key);
    // Only drop the guid entry if it still points HERE. Two records can share an
    // item guid when a feed's enclosure URL moved and both copies were kept;
    // deleting the older must not unhook the newer.
    if (r?.itemGuid && this.byItemGuid.get(r.itemGuid) === key) {
      this.byItemGuid.delete(r.itemGuid);
    }
    this.records.delete(key);
  }

  private setState(key: string, state: DownloadState | null) {
    if (state) this.states.set(key, state);
    else this.states.delete(key);
    this.bump();
  }
}

/**
 * The item's OWN parent feed, never the guid of whatever feed listed it — and
 * whether the feed we were handed is that parent at all.
 *
 * A `musicL` playlist lists tracks that live in hundreds of other feeds, so the
 * container's guid is a fact about the playlist and not about the track — and
 * this is the guid a boost from `/downloads` resolves its payee against. The
 * discriminator is the item's own `podcastGuid`, and it refuses NARROWLY: both
 * guids must be present and disagree before the container's is withheld. Same
 * rule and same reasoning as `<FavEpisodeHeart>`.
 *
 * **THE GUID WAS NEVER THE WHOLE RULE.** The title and the art are facts about
 * the parent feed too, and this returned only the guid — so a track downloaded
 * from a playlist kept its own `feedGuid` while recording the PLAYLIST's title
 * and cover as its show's. `dbRowToPodcast` hands that object to
 * `selectPodcast`, so the mixed-provenance feed is what `/` then renders. The
 * comment here already claimed the withholding; only the guid ever did it.
 * `<FavEpisodeHeart>` is the reference (`components/fav-heart.tsx`), and it
 * withholds `url`, `title`, `image` and `medium` on the same test.
 */
function parentFeed(
  episode: Episode,
  podcast: Podcast | null,
): { feedGuid: string | undefined; containerIsParent: boolean } {
  const feedGuid = episode.podcastGuid ?? podcast?.podcastGuid;
  return {
    feedGuid,
    containerIsParent: !!podcast?.podcastGuid && podcast.podcastGuid === feedGuid,
  };
}

function abortError(): DOMException {
  return new DOMException('cancelled', 'AbortError');
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

function messageFor(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return 'Download failed — tap to retry.';
}

export const downloadManager = new DownloadManager();
