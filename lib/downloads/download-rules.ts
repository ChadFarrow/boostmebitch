/**
 * The three pure decisions the downloads feature rests on.
 *
 * **This module must have NO IMPORTS AT ALL — not even a type-only relative
 * one.** `scripts/check-downloads.mjs` loads the SHIPPING module under
 * `node --experimental-strip-types`, and that only works while nothing here
 * needs resolving. A type-only import is erased by type-stripping, so it would
 * pass every other check while leaving this file one `type` deletion away from
 * breaking the script that pins it. `scripts/import-free.mjs` enforces it.
 *
 * That constraint costs one thing, and it is deliberate: {@link isDownloadable}
 * carries its own copy of the HLS test rather than calling `isHlsUrl`
 * (`lib/util.ts`), which is the app's one answer everywhere else. A second copy
 * drifts, so `check:downloads` has a section asserting the two agree about a
 * list of URLs including the near-misses. If that section ever fails, `isHlsUrl`
 * moved and this file follows it — never the other way round.
 */

/**
 * Reserve this much of the origin's quota, whichever is larger.
 *
 * Not politeness. This origin's `localStorage` holds the NWC spending
 * credential, the Spark mnemonic and the favorites baseline, and they share one
 * quota with these downloads. A full store on iOS Safari makes every subsequent
 * write fail — down to a one-byte `bmb:stream_on` — while reads keep working,
 * so nothing else looks wrong and a fresh profile never reproduces it. See the
 * `safeSet` reasoning in `docs/storage.md`.
 *
 * Both bounds are needed. The flat floor alone would refuse every download on a
 * small quota; the fraction alone leaves a few hundred kilobytes on one, which
 * is not a reserve.
 */
const HEADROOM_BYTES = 64 * 1024 * 1024;
const HEADROOM_FRACTION = 0.05;

/**
 * A hard ceiling on one download, enforced while the bytes stream in.
 *
 * `Content-Length` is a claim, and an endless source does not send one at all —
 * so a cap derived from it is no cap. `downloadBytes` accumulates chunks in an
 * in-memory array before it can write them, which means an unbounded source
 * takes the tab down rather than merely filling the disk. Same reasoning as
 * `lib/capped-body.ts`: a timeout bounds how LONG a fetch runs, never how many
 * bytes it returns.
 *
 * 600 MB is comfortably above a real episode — the largest measured on
 * 2026-09-09 was 193 MB — and far below anything that could be called a file.
 */
export const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024;

/** What `navigator.storage.estimate()` returns, as much of it as we read. */
export interface StorageEstimateLike {
  usage?: number;
  quota?: number;
}

/**
 * The request URL for an episode's chapters document.
 *
 * A BUILDER RATHER THAN TWO STRING LITERALS, and that is the whole reason it is
 * here. `useChapters` builds this URL to fetch, and the download builds it to
 * cache; the cache is keyed by the URL, so the two agreeing character for
 * character IS the feature. StableKraft's equivalent pair — the proxy-first and
 * direct-first domain lists — was hand-mirrored and drifted to 16 entries
 * against 14, and the symptom was "streams fine, won't download".
 *
 * Returns `null` when there is no document to ask for.
 */
export function chaptersRequestUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  return `/api/chapters?url=${encodeURIComponent(url)}`;
}

/** The same, for a transcript. `type` is part of the key because it is part of the request. */
export function transcriptRequestUrl(
  url: string | undefined | null,
  type?: string | null,
): string | null {
  if (!url) return null;
  return `/api/transcript?url=${encodeURIComponent(url)}${type ? `&type=${encodeURIComponent(type)}` : ''}`;
}

/**
 * The canonical key for an enclosure: the Cache API key the bytes are stored
 * under, and the key playback re-derives when it goes looking for them.
 *
 * **It must be idempotent.** `downloadKey(downloadKey(u))` is `downloadKey(u)`
 * for every input, because the play-side call is sometimes handed a URL that has
 * already been through here. A key that changes on re-derivation produces a
 * download that exists on disk and can never be found — with no error anywhere,
 * because both halves believe they are correct.
 *
 * Every normalization below changes NO BYTES ON THE WIRE: the URL this returns
 * fetches exactly what the input would have. That is the whole admission test.
 * In particular an analytics redirect (`podtrac.com/pts/redirect.mp3/…`,
 * `op3.dev/e/…`) is **not** unwrapped — it is part of the URL the host will
 * serve, and a signed CDN URL underneath one is not ours to rewrite.
 *
 * Returns `null` for anything that is not an absolute http(s) URL, which
 * includes `undefined`, junk, a relative path, and the `data:` / `blob:` /
 * `javascript:` schemes.
 */
export function downloadKey(rawUrl: string | undefined | null): string | null {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    // Not absolute, or not parseable at all. A relative path lands here, and it
    // has no host to fetch from.
    return null;
  }

  // An allowlist, never a denylist of bad schemes — the same rule `safeUrlAttr`
  // is under, for the same reason. `blob:` is already local and `data:` carries
  // its own bytes; neither is an enclosure to download.
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

  // The app is https-only, so an http URL would fail the fetch anyway. Upgrading
  // also means a feed that switched to https mid-life does not orphan the
  // download it already wrote.
  if (u.protocol === 'http:') u.protocol = 'https:';

  // A fragment is never sent to the server, so two URLs differing only by one
  // name the same resource — and would otherwise download twice and store twice.
  u.hash = '';

  // `URL` already percent-encodes a literal space in the path, which is what
  // `fetch()` does too. Reading `.href` back is what makes this idempotent: the
  // second pass parses an already-encoded URL and re-serializes it unchanged.
  return u.href;
}

/**
 * Whether this enclosure can be downloaded as a file at all.
 *
 * Two refusals, and neither is about the network:
 *
 * - **HLS.** A `.m3u8` is a manifest listing segments, not audio. Downloading
 *   one stores a few hundred bytes of playlist and reports success — a green
 *   tick over nothing. (See the class comment on why this test is duplicated
 *   here rather than calling `isHlsUrl`.)
 * - **A live item — ANY `<podcast:liveItem>`, whatever its status.** Its
 *   enclosure is a stream URL, not a file: measured 2026-09-09, Homegrown Hits
 *   episode 150 sat at `status="pending"` pointing at
 *   `stream.bowlafterbowl.com/listen/bowlafterbowl/stream.mp3`, an endless
 *   icecast stream. Refusing only `'live'` let the button offer it, and an
 *   endless source has no `Content-Length`, so nothing downstream could size it
 *   either — `downloadBytes` accumulates chunks in memory, so it would have
 *   grown until the tab died. `MAX_DOWNLOAD_BYTES` is the backstop for that;
 *   this is the fix.
 *
 *   `'ended'` is refused too, and that is the deliberate direction to be wrong
 *   in. A publisher who keeps the recording republishes it as an ordinary
 *   `<item>`; an ended `liveItem` usually still names the dead stream. The cost
 *   of refusing one is that a single episode cannot be downloaded. The cost of
 *   allowing one is a download that never finishes, on the connection this
 *   feature exists to spare.
 */
export function isDownloadable(
  rawUrl: string | undefined | null,
  liveStatus?: string | null,
): boolean {
  const key = downloadKey(rawUrl);
  if (!key) return false;
  if (liveStatus) return false;
  // Must agree with `isHlsUrl` in lib/util.ts — pinned by check:downloads.
  if (/\.m3u8(\?|#|$)/i.test(key)) return false;
  return true;
}

/**
 * Is there room for a download of `bytes`?
 *
 * Three answers, and **`'unknown'` allows the download**. That is the load-
 * bearing one: `navigator.storage.estimate()` is absent on older iOS, which is
 * the platform this app is mostly listened on, so answering `'no'` there is a
 * button that does nothing with no explanation — indistinguishable from a
 * broken one. Let a real `QuotaExceededError` be the answer instead.
 *
 * `'no'` means refuse and say so. It is never an instruction to evict: a
 * download is something the listener chose to keep, and deleting one to make
 * room for another is a decision they did not ask for.
 */
export function roomVerdict(
  estimate: StorageEstimateLike | null | undefined,
  bytes: number | null | undefined,
): 'yes' | 'no' | 'unknown' {
  if (!estimate) return 'unknown';
  const { usage, quota } = estimate;
  if (typeof quota !== 'number' || !Number.isFinite(quota) || quota <= 0) return 'unknown';
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return 'unknown';
  const used = typeof usage === 'number' && Number.isFinite(usage) ? usage : 0;
  const headroom = Math.max(HEADROOM_BYTES, quota * HEADROOM_FRACTION);
  return used + bytes + headroom <= quota ? 'yes' : 'no';
}
