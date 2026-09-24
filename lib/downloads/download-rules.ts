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

/**
 * The app's own URL for an enclosure a host would not hand to the browser.
 *
 * `encodeURIComponent`, never a bare append. An enclosure routinely carries its
 * own query string — the Simplecast vector in `check:downloads` has
 * `?aid=rss_feed&awEpisodeId=…&feed=…` — so appending it raw would let the
 * FEED author add parameters to OUR route, and `searchParams.get('url')` would
 * then read a truncated address. `chaptersRequestUrl` and
 * `transcriptRequestUrl` above encode for the same reason.
 *
 * Relative, not absolute: the route is same-origin by construction, so there is
 * no origin to get wrong and no CORS question to answer on the way back.
 */
export function proxiedAudioUrl(sourceUrl: string): string {
  return `/api/audio?url=${encodeURIComponent(sourceUrl)}`;
}

/**
 * What to say when the enclosure fetch threw.
 *
 * **A blocked host and a dead network are the SAME `TypeError`**, and saying
 * "Could not reach mmmusic.show" for both was wrong in the case that actually
 * happens. Reported from an iPhone on 2026-09-20: the show streamed perfectly
 * while its DOWNLOAD chip read "Could not reach", which names the one cause
 * that was not true — the host was up and serving the same 90 MB file to the
 * `<audio>` element two inches below the message.
 *
 * `<audio src>` needs no CORS header and `fetch()` does, so a host that omits
 * `Access-Control-Allow-Origin` plays and cannot be saved. Measured that day:
 * op3.dev, libsyn, megaphone, transistor and buzzsprout all send it;
 * `mmmusic.show`, `anchor.fm` and `mp3s.nashownotes.com` do not. **The note in
 * `downloads-cache.ts` claiming five-of-five hosts send it was a sample that
 * happened to miss self-hosted shows**, which V4V podcasts often are.
 *
 * `reachable` comes from a `no-cors` HEAD to the same URL, which is the exact
 * discriminator and costs one round trip: an opaque response RESOLVES whenever
 * the server answered at all — any status, 405 included — and rejects only when
 * the device could not get there. `navigator.onLine` cannot do this job: it
 * reports whether an interface exists, so it is `true` on a captive portal and
 * on wifi with no route out.
 *
 * Neither message says "try again". A CORS policy will not change on a retry,
 * and telling someone to repeat a thing that cannot work is how a one-off
 * refusal becomes a habit of distrusting the button.
 */
export function downloadFailureMessage(host: string, reachable: boolean): string {
  const where = host || 'this host';
  return reachable
    ? `${where} does not let other apps save its audio. You can still play and boost this episode.`
    : `No connection — this device could not reach ${where}.`;
}

/**
 * Where one track of an album stands, as far as downloading it is concerned.
 *
 * `'active'` is queued or downloading. `'none'` includes a FAILED track, because
 * pressing the album control again is how a failure is retried.
 */
export type AlbumTrackState = 'none' | 'active' | 'done';

export interface AlbumTrack {
  /** The enclosure URL as the feed wrote it. */
  url: string | null | undefined;
  liveStatus?: string | null;
  /** The feed's `<enclosure length>` — a HINT, routinely absent or `0`. */
  bytes?: number | null;
  state: AlbumTrackState;
}

export interface AlbumPlan {
  /** Indexes into the input, in the order given, of the tracks a press fetches. */
  fetch: number[];
  /** The summed size of `fetch`, counting only the tracks that state one. */
  knownBytes: number;
  /** How many of `fetch` state no usable size. */
  unknownSize: number;
  /** Tracks already on the device. */
  done: number;
  /** Tracks queued or downloading right now. */
  active: number;
  /** Distinct downloadable tracks: `fetch.length + done + active`. */
  total: number;
}

/**
 * What pressing DOWNLOAD ALBUM would fetch, and what it would cost.
 *
 * **One plan feeds both the number on the control and the press**, which is the
 * boost modal's rule pointed at data instead of sats: a total computed by the
 * surface and a list computed by the engine can disagree, and then the listener
 * agreed to one spend and got another. `DownloadManager.planAlbum` is the one
 * caller; the control renders its answer and `downloadAlbum` re-asks it at the
 * moment of the press.
 *
 * The obvious version — "sum every `<enclosure length>` and fetch every track" —
 * is wrong four ways, and each is a vector in `check:downloads`:
 *
 * - **A track already on the device costs nothing.** Counting it states a spend
 *   the press will not make, which on the second press of a half-downloaded
 *   album is most of the number.
 * - **A duplicate URL is ONE file.** `download()` already refuses a second copy
 *   by key, so a feed that lists the same enclosure twice would be charged twice
 *   and fetched once.
 * - **A track that can never be downloaded is not part of the album here** —
 *   a live item or an HLS manifest. `isDownloadable` is the one answer, so the
 *   album and the single-track button can never disagree about a row.
 * - **An absent or `0` size is UNKNOWN, never zero.** The same rule as the
 *   single-track button: "0 MB" beside a real file is worse than silence, and a
 *   sum that quietly treats a missing size as nothing understates the spend by
 *   exactly the tracks nobody measured. `unknownSize` lets the surface say so.
 *
 * No album is too large to offer. What makes this safe is not a cap but the
 * number shown before the press — the reason bulk download was left out at
 * first was that it spends "without a screen in front of" the listener, and a
 * stated total plus a confirmation is that screen.
 */
export function albumPlan(tracks: AlbumTrack[]): AlbumPlan {
  const plan: AlbumPlan = { fetch: [], knownBytes: 0, unknownSize: 0, done: 0, active: 0, total: 0 };
  const seen = new Set<string>();
  tracks.forEach((t, i) => {
    if (!isDownloadable(t.url, t.liveStatus)) return;
    // Non-null: `isDownloadable` already required a key.
    const key = downloadKey(t.url) as string;
    if (seen.has(key)) return;
    seen.add(key);
    plan.total += 1;
    if (t.state === 'done') { plan.done += 1; return; }
    if (t.state === 'active') { plan.active += 1; return; }
    plan.fetch.push(i);
    if (typeof t.bytes === 'number' && Number.isFinite(t.bytes) && t.bytes > 0) plan.knownBytes += t.bytes;
    else plan.unknownSize += 1;
  });
  return plan;
}

/** As much of a `DownloadRecord` as grouping reads. Structural, because this
 *  module may import nothing — not even that type. */
export interface GroupableDownload {
  key: string;
  feedGuid?: string;
  feedId?: number;
  createdAt: number;
}

/** One entry on `/downloads`: a download on its own, or a show's downloads. */
export type DownloadListItem<T extends GroupableDownload> =
  | { kind: 'one'; record: T }
  | { kind: 'show'; id: string; records: T[] };

/**
 * `/downloads` as the listener reads it: a show with two or more downloads is
 * ONE entry that opens, and everything else is a row.
 *
 * Asked for from an iPhone after the first DOWNLOAD ALBUM: fourteen Tinderbox
 * rows, each saying "Tinderbox", pushed every other download off the screen.
 *
 * **The show is the item's OWN parent feed** — `feedGuid`, else `feedId` — for
 * the reason `DownloadRecord.feedGuid` documents: a `musicL` playlist lists
 * tracks from other feeds, so its tracks group under their real albums rather
 * than under the playlist that happened to list them.
 *
 * **A record that names no show is never grouped.** The obvious version —
 * group by `r.feedGuid` — puts every record without one into a single bucket
 * keyed `undefined`, so unrelated downloads from different shows arrive as one
 * nameless entry. `feedId` must be a positive integer to count, because `0` is
 * what a missing number becomes on the way through a form.
 *
 * **Orders.** Entries are newest first by their NEWEST download, so the page
 * still opens on what was just saved. Inside a show, downloads are in the order
 * they were TAKEN — DOWNLOAD ALBUM queues in the album page's order, so an album
 * downloaded whole reads in album order, and it needs no field the records
 * already on a phone do not have. An album taken one track at a time out of
 * order reads in that order; the record holds no track number to do better.
 * Every tie falls to the key, so the page never reorders between two renders.
 */
export function groupDownloads<T extends GroupableDownload>(records: T[]): DownloadListItem<T>[] {
  const showOf = (r: T): string | null => {
    if (r.feedGuid) return `guid:${r.feedGuid}`;
    if (typeof r.feedId === 'number' && Number.isInteger(r.feedId) && r.feedId > 0) return `id:${r.feedId}`;
    return null;
  };
  const byKey = (a: T, b: T) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

  const shows = new Map<string, T[]>();
  for (const r of records) {
    const id = showOf(r);
    if (id) shows.set(id, [...(shows.get(id) ?? []), r]);
  }

  const items: Array<{ item: DownloadListItem<T>; newest: number; tie: string }> = [];
  for (const r of records) {
    const id = showOf(r);
    const members = id ? shows.get(id)! : null;
    if (!id || !members || members.length < 2) {
      items.push({ item: { kind: 'one', record: r }, newest: r.createdAt, tie: r.key });
      continue;
    }
    // Once per show: the first member met emits it.
    if (members[0] !== r) continue;
    const inOrder = [...members].sort((a, b) => a.createdAt - b.createdAt || byKey(a, b));
    items.push({
      item: { kind: 'show', id, records: inOrder },
      newest: Math.max(...members.map((m) => m.createdAt)),
      tie: id,
    });
  }
  return items
    .sort((a, b) => b.newest - a.newest || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0))
    .map((x) => x.item);
}
