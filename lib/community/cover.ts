import sharp from 'sharp';
import { batchEpisodes, episodeKey } from '../pi-batch';
import { fetchImageBytes, IMAGE_PIXEL_LIMIT } from './checks';
import type { PlaylistSong } from './rules';

// SERVER-ONLY. The 1400 x 1400 JPEG cover of a community playlist.

const SIZE = 1400;
const HALF = SIZE / 2;
const BG = '#0A0A08';
const ACCENT = '#FAE500';

const QUALITY = { quality: 85, mozjpeg: true } as const;

/** A cover link re-encoded as 1400 x 1400 JPEG, or null when it cannot be read. */
export async function coverFromArtUrl(url: string): Promise<Buffer | null> {
  try {
    const buf = await fetchImageBytes(url);
    return await sharp(buf, { limitInputPixels: IMAGE_PIXEL_LIMIT })
      .resize(SIZE, SIZE, { fit: 'cover' })
      .flatten({ background: BG })
      .jpeg(QUALITY)
      .toBuffer();
  } catch {
    return null;
  }
}

async function tile(url: string): Promise<Buffer | null> {
  try {
    const buf = await fetchImageBytes(url);
    return await sharp(buf, { limitInputPixels: IMAGE_PIXEL_LIMIT })
      .resize(HALF, HALF, { fit: 'cover' })
      .flatten({ background: BG })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

/**
 * The 2 x 2 grid of the first songs' art on a dark canvas. A missing tile repeats
 * the previous one; no art at all gives the canvas with a centred note in yellow.
 */
export async function buildGridCover(songs: PlaylistSong[]): Promise<Buffer> {
  const first = songs.slice(0, 4);
  let urls: (string | null)[] = [];
  try {
    const eps = first.length ? await batchEpisodes(first) : {};
    urls = first.map((s) => {
      const e = eps[episodeKey(s)];
      return e?.image ?? e?.feedImage ?? null;
    });
  } catch {
    urls = first.map(() => null);
  }
  const tiles = await Promise.all(urls.map((u) => (u ? tile(u) : Promise.resolve(null))));
  const canvas = sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: BG } });
  if (!tiles.some(Boolean)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">`
      + `<text x="50%" y="50%" font-size="640" fill="${ACCENT}" text-anchor="middle" dominant-baseline="central" font-family="sans-serif">♫</text></svg>`;
    return canvas.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg(QUALITY).toBuffer();
  }
  const spots = [[0, 0], [HALF, 0], [0, HALF], [HALF, HALF]];
  let prev: Buffer | null = tiles.find(Boolean) ?? null;
  const layers = spots.map(([left, top], i) => {
    const t = tiles[i] ?? prev;
    if (t) prev = t;
    return t ? { input: t, left, top } : null;
  }).filter((l): l is { input: Buffer; left: number; top: number } => l !== null);
  return canvas.composite(layers).jpeg(QUALITY).toBuffer();
}
