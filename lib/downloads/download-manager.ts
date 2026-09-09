import { artCandidates } from '../util';
import type { Episode, Podcast } from '../types';
import { downloadKey, isDownloadable } from './download-rules';
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
  deleteImage: typeof cache.deleteImage;
  requestPersistence: typeof cache.requestPersistence;
  putRecord: typeof db.putRecord;
  getRecordByItemGuid: typeof db.getRecordByItemGuid;
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
  deleteImage: cache.deleteImage,
  requestPersistence: cache.requestPersistence,
  putRecord: db.putRecord,
  getRecordByItemGuid: db.getRecordByItemGuid,
  getAllRecords: db.getAllRecords,
  deleteRecord: db.deleteRecord,
  clearAllRecords: db.clearAllRecords,
};

export class DownloadManager {
  private backend: DownloadsBackend;
  private records = new Map<string, DownloadRecord>();
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
        for (const r of await this.backend.getAllRecords()) this.records.set(r.key, r);
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

  getEpisodeState(episode: Episode | null | undefined): DownloadState {
    return this.getState(this.keyFor(episode));
  }

  /** Newest first — the order `/downloads` renders. */
  listDownloads(): DownloadRecord[] {
    return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  totalBytes(): number {
    let total = 0;
    for (const r of this.records.values()) total += r.sizeBytes || 0;
    return total;
  }

  // --- writing ---------------------------------------------------------------

  async download(episode: Episode, podcast?: Podcast | null): Promise<boolean> {
    const key = this.keyFor(episode);
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
      // `Episode` carries no byte length — RSS's `<enclosure length>` is not
      // parsed into it. So the size is not known until the response HEADERS
      // arrive, which is still before any of the body, and `downloadBytes`
      // re-runs the room check there. Passing a length here becomes possible if
      // the parser ever keeps one.
      expectedBytes: null,
      signal,
      onProgress: (p) => this.setState(key, { status: 'downloading', fraction: p.fraction }),
    });

    const record: DownloadRecord = {
      key,
      enclosureUrl: episode.enclosureUrl,
      enclosureType: episode.enclosureType,
      sizeBytes,
      createdAt: Date.now(),
      itemGuid: episode.guid,
      feedGuid: parentFeedGuid(episode, podcast),
      feedId: episode.feedId,
      title: episode.title,
      feedTitle: episode.feedTitle ?? podcast?.title,
      image: episode.image,
      feedImage: episode.feedImage ?? podcast?.image ?? podcast?.artwork,
      duration: episode.duration,
      datePublished: episode.datePublished,
      value: episode.value,
      valueTimeSplits: episode.valueTimeSplits,
    };

    await this.backend.putRecord(record);
    this.records.set(key, record);
    this.setState(key, null);

    // Art is a nicety and never blocks the download reporting success.
    //
    // It MUST be the `/api/art` copy, which is same-origin: a cross-origin image
    // fetch yields an opaque response, and an opaque response can never become a
    // blob URL — it would store bytes that read back empty. `artCandidates`
    // puts the proxied URLs first and the raw ones behind them, so the raw tail
    // is skipped here rather than cached uselessly.
    const proxied = artCandidates(record.image, record.feedImage, 640)
      .find((u) => u.startsWith('/api/art'));
    if (proxied) void this.backend.downloadImage(key, proxied);

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
    this.records.delete(key);
    this.setState(key, null);
    await Promise.all([
      this.backend.deleteRecord(key).catch(() => {}),
      this.backend.deleteBytes(key).catch(() => {}),
      this.backend.deleteImage(key).catch(() => {}),
    ]);
    this.bump();
  }

  async clearAll(): Promise<void> {
    for (const c of this.controllers.values()) c.abort();
    this.records.clear();
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
    this.records.delete(key);
    this.states.delete(key);
    await this.backend.deleteRecord(key).catch(() => {});
    this.bump();
  }

  /**
   * The blob URL for this episode's local bytes, or `null`.
   *
   * Two lookups, and the second is why `downloads-db.ts` carries an `itemGuid`
   * index: an episode object can be enriched in place and arrive with a NEW
   * `enclosureUrl` on the same id — a feed moving CDN, or gaining an analytics
   * wrapper — which a URL-derived key alone would read as a different episode.
   *
   * **The caller owns revoking the URL.**
   */
  async resolveSource(episode: Episode | null | undefined): Promise<string | null> {
    if (!episode) return null;
    await this.hydrate();

    const key = this.keyFor(episode);
    if (key && this.records.has(key)) {
      const url = await this.backend.getObjectUrl(key);
      if (url) return url;
      await this.forgetEvicted(key);
      return null;
    }

    if (!episode.guid) return null;
    let byGuid: DownloadRecord | null = null;
    try {
      byGuid = await this.backend.getRecordByItemGuid(episode.guid);
    } catch {
      return null;
    }
    if (!byGuid) return null;
    const url = await this.backend.getObjectUrl(byGuid.key);
    if (url) return url;
    await this.forgetEvicted(byGuid.key);
    return null;
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

  private setState(key: string, state: DownloadState | null) {
    if (state) this.states.set(key, state);
    else this.states.delete(key);
    this.bump();
  }
}

/**
 * The item's OWN parent feed, never the guid of whatever feed listed it.
 *
 * A `musicL` playlist lists tracks that live in hundreds of other feeds, so the
 * container's guid is a fact about the playlist and not about the track — and
 * this is the guid a boost from `/downloads` resolves its payee against. The
 * discriminator is the item's own `podcastGuid`, and it refuses NARROWLY: both
 * guids must be present and disagree before the container's is withheld. Same
 * rule and same reasoning as `<FavEpisodeHeart>`.
 */
function parentFeedGuid(episode: Episode, podcast: Podcast | null): string | undefined {
  if (episode.podcastGuid) return episode.podcastGuid;
  return podcast?.podcastGuid;
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
