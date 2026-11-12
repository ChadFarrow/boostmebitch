import sharp from 'sharp';
import { safeFetch } from '../safe-fetch';
import { readCappedBytes } from '../capped-body';
import { batchEpisodes, batchPodcasts, episodeKey, MAX_BATCH } from '../pi-batch';
import { artVerdict, type ArtRefusal, type PlaylistSong } from './rules';

// SERVER-ONLY. The two checks a draft passes before it is stored: the cover
// art is fetched and measured, and every song is looked up in Podcast Index.

/**
 * Fetch an image through the SSRF-safe fetcher, capped at 12 MB and 10 s. Throws
 * on an unsafe address, a non-200, a timeout or a body that is too large. The one
 * fetch helper both the art check and the cover builder (cover.ts) use.
 */
export async function fetchImageBytes(url: string): Promise<Buffer> {
  const res = await safeFetch(url, {
    headers: { accept: 'image/*' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`image fetch ${res.status}`);
  }
  return Buffer.from(await readCappedBytes(res, 12 * 1024 * 1024));
}

/** Decode limit shared by the art check and the cover builder. */
export const IMAGE_PIXEL_LIMIT = 24_000_000;

/** Fetch the cover and judge it. A cover that cannot be read is `not-image`. */
export async function checkArt(url: string): Promise<{ ok: true } | { ok: false; reason: ArtRefusal }> {
  try {
    const buf = await fetchImageBytes(url);
    const m = await sharp(buf, { limitInputPixels: IMAGE_PIXEL_LIMIT }).metadata();
    return artVerdict({ format: m.format, width: m.width, height: m.height, hasAlpha: m.hasAlpha });
  } catch {
    // Unsafe address, timeout, too large, undecodable: none of them is a usable cover.
    return { ok: false, reason: 'not-image' };
  }
}

/**
 * Which songs Podcast Index does not know, and which sit in a feed whose medium
 * is known and is not `music`. Three states from `batchEpisodes`: a value is
 * found, `null` is not found, and an absent key means nobody could be asked,
 * which passes (a Podcast Index outage must not refuse a listener's playlist).
 */
export async function verifySongs(
  songs: PlaylistSong[],
): Promise<{ notFound: string[]; notMusic: string[] }> {
  // Stop at the first chunk that holds a missing song: the draft is refused
  // already, and a 500-song draft of made-up guids must not cost five PI calls.
  const notFound = new Set<string>();
  for (let i = 0; i < songs.length && notFound.size === 0; i += MAX_BATCH) {
    const chunk = songs.slice(i, i + MAX_BATCH);
    const found = await batchEpisodes(chunk.map((s) => ({ feedGuid: s.feedGuid, itemGuid: s.itemGuid })));
    for (const s of chunk) {
      const k = episodeKey(s);
      if (k in found && found[k] === null) notFound.add(s.itemGuid);
    }
  }
  // A refused draft needs no medium lookup.
  if (notFound.size) return { notFound: [...notFound], notMusic: [] };

  const mediums = new Map<string, string | undefined>();
  const guids = [...new Set(songs.map((s) => s.feedGuid))];
  for (let i = 0; i < guids.length; i += MAX_BATCH) {
    const chunk = guids.slice(i, i + MAX_BATCH);
    const pods = await batchPodcasts(chunk);
    for (const g of chunk) {
      const p = pods[g];
      if (p) mediums.set(g, p.medium);
    }
  }
  const notMusic = songs
    .filter((s) => {
      const m = mediums.get(s.feedGuid);
      return !!m && m !== 'music';
    })
    .map((s) => s.itemGuid);
  return { notFound: [], notMusic: [...new Set(notMusic)] };
}
