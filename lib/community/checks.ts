import sharp from 'sharp';
import { safeFetch } from '../safe-fetch';
import { readCappedBytes } from '../capped-body';
import { batchEpisodes, batchPodcasts, episodeKey, MAX_BATCH } from '../pi-batch';
import { artVerdict, type ArtRefusal, type PlaylistSong } from './rules';

// SERVER-ONLY. The two checks a draft passes before it is stored: the cover
// art is fetched and measured, and every song is looked up in Podcast Index.

/** Fetch the cover and judge it. A cover that cannot be read is `not-image`. */
export async function checkArt(url: string): Promise<{ ok: true } | { ok: false; reason: ArtRefusal }> {
  try {
    const res = await safeFetch(url, {
      headers: { accept: 'image/*' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, reason: 'not-image' };
    const buf = await readCappedBytes(res, 12 * 1024 * 1024);
    const m = await sharp(Buffer.from(buf), { limitInputPixels: 24_000_000 }).metadata();
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
  const notFound = new Set<string>();
  for (let i = 0; i < songs.length; i += MAX_BATCH) {
    const chunk = songs.slice(i, i + MAX_BATCH);
    const found = await batchEpisodes(chunk.map((s) => ({ feedGuid: s.feedGuid, itemGuid: s.itemGuid })));
    for (const s of chunk) {
      const k = episodeKey(s);
      if (k in found && found[k] === null) notFound.add(s.itemGuid);
    }
  }
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
    .filter((s) => !notFound.has(s.itemGuid))
    .filter((s) => {
      const m = mediums.get(s.feedGuid);
      return !!m && m !== 'music';
    })
    .map((s) => s.itemGuid);
  return { notFound: [...notFound], notMusic: [...new Set(notMusic)] };
}
