import sharp from 'sharp';
import { batchEpisodes, episodeKey } from '../pi-batch';
import { closedService } from '../moved-feeds';
import { fetchImageBytes, IMAGE_PIXEL_LIMIT } from './checks';
import { COVER_BG, COVER_JPEG, COVER_SIZE, composeCover } from './cover-compose';
import type { PlaylistSong } from './rules';

// SERVER-ONLY. The 1400 x 1400 JPEG cover of a community playlist.

export interface CoverResult {
  jpg: Buffer;
  /** `art` the listener's link; `grid` the first songs' art; `song` one song's art; `note` the plain canvas. */
  source: 'art' | 'grid' | 'song' | 'note';
  /** True when a failure (a fetch or Podcast Index) caused a fallback: do not cache it long. */
  failed: boolean;
}

/** A cover link re-encoded as 1400 x 1400 JPEG, or null when it cannot be read. */
async function coverFromArtUrl(url: string): Promise<Buffer | null> {
  try {
    const buf = await fetchImageBytes(url);
    return await sharp(buf, { limitInputPixels: IMAGE_PIXEL_LIMIT })
      .resize(COVER_SIZE, COVER_SIZE, { fit: 'cover' })
      .flatten({ background: COVER_BG })
      .jpeg(COVER_JPEG)
      .toBuffer();
  } catch {
    return null;
  }
}

/**
 * A picture fitted to `size` x `size`, or why there is none. `'unusable'` is
 * PERMANENT: the file is gone (404/410) or its bytes will never decode here
 * (over the pixel limit, not an image). `'transient'` is a host's bad minute
 * (timeout, 5xx, network). Only a transient miss marks a cover `failed`, which
 * keeps it 5 minutes instead of a day: a permanent one would otherwise rebuild
 * the same cover all day long. Measured 2026-11-15 on "ChadF's favorite V4V
 * albums": its third song's cover is 8640 x 8283 (71.6 MP, over
 * IMAGE_PIXEL_LIMIT), and "Christmas" has an RSS Blue song (410), so both
 * covers were held 5 minutes forever.
 */
async function fitImage(url: string, size: number, as: 'png' | 'jpeg'): Promise<Buffer | 'unusable' | 'transient'> {
  let buf: Buffer;
  try {
    buf = await fetchImageBytes(url);
  } catch (e) {
    const status = /image fetch (\d+)/.exec(e instanceof Error ? e.message : '')?.[1];
    return status === '404' || status === '410' ? 'unusable' : 'transient';
  }
  try {
    const img = sharp(buf, { limitInputPixels: IMAGE_PIXEL_LIMIT })
      .resize(size, size, { fit: 'cover' })
      .flatten({ background: COVER_BG });
    return await (as === 'png' ? img.png() : img.jpeg(COVER_JPEG)).toBuffer();
  } catch {
    // The same bytes fail the same way next time: too many pixels, or not an image.
    return 'unusable';
  }
}

/** One grid tile. */
const tile = (url: string) => fitImage(url, COVER_SIZE / 2, 'png');

/**
 * The art of the first four songs, from one Podcast Index batch. `failed` when
 * Podcast Index could not be asked (an absent key, or a throw).
 */
async function firstSongArt(songs: PlaylistSong[]): Promise<{ urls: (string | null)[]; failed: boolean }> {
  const first = songs.slice(0, 4);
  try {
    const eps = first.length ? await batchEpisodes(first) : {};
    // An absent key means Podcast Index could not be asked: that is a failure, not "no art".
    const failed = first.some((s) => !(episodeKey(s) in eps));
    return {
      urls: first.map((s) => {
        const e = eps[episodeKey(s)];
        return e?.image ?? e?.feedImage ?? null;
      }),
      failed,
    };
  } catch {
    return { urls: first.map(() => null), failed: true };
  }
}

/** The 2 x 2 grid of the first four songs' art. Tiles are decoded one after another (memory). */
async function buildGridCover(songs: PlaylistSong[]): Promise<{ jpg: Buffer; anyTile: boolean; failed: boolean }> {
  const art = await firstSongArt(songs);
  let failed = art.failed;
  const urls = art.urls;
  const tiles: (Buffer | null)[] = [];
  for (const u of urls) {
    // A host that CLOSED is not asked at all (`lib/moved-feeds.ts`): every file
    // there answers 410, and it is no failure of ours.
    if (!u || closedService(u)) { tiles.push(null); continue; }
    const t = await tile(u);
    if (t === 'transient') failed = true;
    tiles.push(t === 'unusable' || t === 'transient' ? null : t);
  }
  return { jpg: await composeCover(tiles), anyTile: tiles.some(Boolean), failed };
}

/** The listener's art link when it reads, else the grid, else the note. */
export async function buildCover(artUrl: string | null, songs: PlaylistSong[]): Promise<CoverResult> {
  let failed = false;
  if (artUrl) {
    const art = await coverFromArtUrl(artUrl);
    if (art) return { jpg: art, source: 'art', failed: false };
    failed = true;
  }
  const g = await buildGridCover(songs);
  return { jpg: g.jpg, source: g.anyTile ? 'grid' : 'note', failed: failed || g.failed };
}

/**
 * One song's art as the whole cover: the FIRST of the first four songs whose
 * art loads, at 1400 x 1400. The style v4vmusic.com uses for a playlist
 * (`coverStyleFor`). A song on a closed host, or with dead or unusable art, is
 * passed over, the same tile rules as the grid; with none left it is the plain
 * note. `failed` (5-minute cache) only for a transient miss, so a cover that
 * fell back to a LATER song because an earlier one had a bad minute corrects
 * itself.
 */
export async function buildFirstSongCover(songs: PlaylistSong[]): Promise<CoverResult> {
  const art = await firstSongArt(songs);
  let failed = art.failed;
  for (const u of art.urls) {
    if (!u || closedService(u)) continue;
    const img = await fitImage(u, COVER_SIZE, 'jpeg');
    if (img === 'transient') { failed = true; continue; }
    if (img === 'unusable') continue;
    return { jpg: img, source: 'song', failed };
  }
  return { jpg: await composeCover([]), source: 'note', failed };
}
