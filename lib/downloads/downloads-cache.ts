import { roomVerdict } from './download-rules';

/**
 * The bytes half of a download.
 *
 * CACHE API, NOT INDEXEDDB, and the reason is atomicity: `Cache.put` either
 * stores the whole response or nothing. A cancelled or failed download
 * therefore leaves nothing behind, so there is no half-written entry to detect
 * and clean up — which is the class of bug that would otherwise produce a green
 * tick over a truncated file.
 *
 * PERSISTENCE INVARIANT: both bucket names are on-disk identifiers. Renaming
 * one does not migrate anything; it orphans every listener's library silently,
 * leaving the bytes on disk with nothing able to find, play or delete them.
 */
const AUDIO_CACHE = 'bmb-downloads-v1';
const ART_CACHE = 'bmb-downloads-art-v1';

export interface DownloadProgress {
  receivedBytes: number;
  /** `null` when the host sent no `Content-Length`. */
  totalBytes: number | null;
  /** 0..1, or `null` when the total is unknown. */
  fraction: number | null;
}

/**
 * Raised when the download was refused before a single byte was fetched.
 *
 * Distinct from a failure on purpose: nothing was attempted, nothing was spent,
 * and the message is written to be shown to a person rather than logged.
 */
export class DownloadRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadRefused';
  }
}

function cachesAvailable(): boolean {
  return typeof caches !== 'undefined';
}

export async function estimateUsage(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (typeof quota !== 'number') return null;
    return { usage: usage ?? 0, quota };
  } catch {
    return null;
  }
}

/**
 * Ask the browser to keep this origin's storage rather than evicting it under
 * pressure. Best effort — Safari does not grant it, which is why the eviction
 * self-heal path in the player exists rather than being a fallback nobody hits.
 */
export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** The room check, split so `roomVerdict`'s arithmetic stays pinnable. */
export async function hasRoomFor(bytes: number | null | undefined): Promise<'yes' | 'no' | 'unknown'> {
  return roomVerdict(await estimateUsage(), bytes);
}

/**
 * Fetch an enclosure and store it under `key`.
 *
 * NO PROXY, AND THAT IS A MEASUREMENT. `<audio src>` needs no CORS header but
 * `fetch()` does, so the obvious worry is that most hosts would refuse. Five
 * real enclosures were tested on 2026-09-09 — a self-hosted mp3, Megaphone and
 * Simplecast each behind a Podtrac redirect, archive.org, and a Fountain music
 * track — and every one sent `Access-Control-Allow-Origin`. So this app keeps
 * its "no proxy" property: no SSRF surface, no audio bytes billed through
 * Vercel, and no domain allowlist to drift out of date. A host that does not
 * send the header fails here, and the caller renders that in words.
 *
 * One shot, whole file, no Range requests and no resume. Resuming would need
 * the partial bytes kept somewhere, which is the half-written entry the Cache
 * API arrangement above exists to avoid.
 *
 * @returns the number of bytes stored.
 */
export async function downloadBytes(
  key: string,
  opts: {
    sourceUrl: string;
    expectedBytes?: number | null;
    onProgress?: (p: DownloadProgress) => void;
    signal?: AbortSignal;
  },
): Promise<number> {
  if (!cachesAvailable()) throw new DownloadRefused('This browser cannot store downloads.');

  const { sourceUrl, expectedBytes, onProgress, signal } = opts;

  // Ask BEFORE fetching. Refusing after the bytes are on the wire has already
  // spent the bandwidth this feature exists to save.
  if (expectedBytes) {
    const room = await hasRoomFor(expectedBytes);
    if (room === 'no') {
      throw new DownloadRefused('Not enough space — remove a download to make room.');
    }
  }

  let res: Response;
  try {
    res = await fetch(sourceUrl, { signal, credentials: 'omit', mode: 'cors' });
  } catch (e) {
    // An abort is the user cancelling and must stay distinguishable.
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    // A CORS refusal and an offline device are the same TypeError here. The
    // caller decides which to say; naming the host is what makes it actionable.
    throw new Error(`Could not reach ${hostOf(sourceUrl)} to download this episode.`);
  }
  if (!res.ok) throw new Error(`${hostOf(sourceUrl)} answered ${res.status}.`);
  if (!res.body) throw new Error('This host sent no audio.');

  const declared = Number(res.headers.get('content-length'));
  const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null;

  // The size is often only knowable now. Check again rather than trusting the
  // feed's `enclosureLength`, which is routinely wrong or absent.
  if (totalBytes && totalBytes !== expectedBytes) {
    const room = await hasRoomFor(totalBytes);
    if (room === 'no') {
      throw new DownloadRefused('Not enough space — remove a download to make room.');
    }
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  // Progress fires on ~5% buckets. Notifying per chunk re-renders the whole
  // subtree hundreds of times a second for a bar that moves one pixel.
  let lastBucket = -1;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      receivedBytes += value.byteLength;
      const fraction = totalBytes ? Math.min(1, receivedBytes / totalBytes) : null;
      const bucket = fraction === null ? -1 : Math.floor(fraction * 20);
      if (onProgress && bucket !== lastBucket) {
        lastBucket = bucket;
        onProgress({ receivedBytes, totalBytes, fraction });
      }
    }
  } catch (e) {
    // Release the connection before rethrowing, or an aborted download leaves
    // the socket open until the tab is closed.
    reader.cancel().catch(() => {});
    throw e;
  }

  const type = res.headers.get('content-type') ?? 'audio/mpeg';
  const blob = new Blob(chunks as BlobPart[], { type });
  const cache = await caches.open(AUDIO_CACHE);
  try {
    await cache.put(key, new Response(blob, { headers: { 'content-type': type } }));
  } catch {
    // The only way past `hasRoomFor` is a quota we could not estimate, which is
    // exactly the iOS case `roomVerdict` returns 'unknown' for. This is that
    // decision arriving late, and it is still a refusal rather than a failure.
    throw new DownloadRefused('Not enough space — remove a download to make room.');
  }
  return blob.size;
}

/**
 * The blob URL for a stored download, or `null` if the bytes are gone.
 *
 * **`null` is not an error.** iOS evicts an origin's storage under pressure
 * without telling anyone, so a record whose bytes have vanished is an ordinary
 * state. The caller forgets the record and streams instead — which is what the
 * listener had before they pressed download.
 *
 * **The caller owns revoking the URL.** A leaked one pins the whole file in
 * memory for the life of the document.
 */
export async function getObjectUrl(key: string): Promise<string | null> {
  if (!cachesAvailable()) return null;
  try {
    const cache = await caches.open(AUDIO_CACHE);
    const res = await cache.match(key);
    if (!res) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}

export async function deleteBytes(key: string): Promise<void> {
  if (!cachesAvailable()) return;
  try {
    const cache = await caches.open(AUDIO_CACHE);
    await cache.delete(key);
  } catch {
    // A delete that fails leaves bytes we can no longer reach. Nothing useful
    // to tell the user, and the record is removed either way.
  }
}

export async function clearAllBytes(): Promise<void> {
  if (!cachesAvailable()) return;
  try {
    await caches.delete(AUDIO_CACHE);
    await caches.delete(ART_CACHE);
  } catch {
    // As above.
  }
}

/**
 * Store an episode's cover art.
 *
 * **It must be fetched through `/api/art`, which is same-origin.** A bare
 * cross-origin image fetch yields an opaque response, and an opaque response can
 * never become a blob URL — it would store bytes that read back empty. The
 * caller passes the already-proxied URL from `artProxyUrl`.
 *
 * Failure is swallowed: art is a nicety and a download without it still plays.
 */
export async function downloadImage(key: string, proxiedUrl: string): Promise<void> {
  if (!cachesAvailable()) return;
  try {
    const res = await fetch(proxiedUrl);
    if (!res.ok) return;
    const cache = await caches.open(ART_CACHE);
    await cache.put(key, res);
  } catch {
    // See above.
  }
}

export async function getImageObjectUrl(key: string): Promise<string | null> {
  if (!cachesAvailable()) return null;
  try {
    const cache = await caches.open(ART_CACHE);
    const res = await cache.match(key);
    if (!res) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}

export async function deleteImage(key: string): Promise<void> {
  if (!cachesAvailable()) return;
  try {
    const cache = await caches.open(ART_CACHE);
    await cache.delete(key);
  } catch {
    // See above.
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'this host';
  }
}
