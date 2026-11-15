import sharp from 'sharp';
import { batchEpisodes, episodeKey } from '../pi-batch';
import { closedService } from '../moved-feeds';
import { fetchImageBytes, IMAGE_PIXEL_LIMIT } from './checks';
import { COVER_BG, COVER_JPEG, COVER_SIZE, composeCover } from './cover-compose';
import type { PlaylistSong } from './rules';

// SERVER-ONLY. The 1400 x 1400 JPEG cover of a community playlist.

export interface CoverResult {
  jpg: Buffer;
  /** `art` the listener's link; `grid` the first songs' art; `note` the plain canvas. */
  source: 'art' | 'grid' | 'note';
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
 * One grid tile, or why there is none. `'unusable'` is PERMANENT: the file is
 * gone (404/410) or its bytes will never decode here (over the pixel limit, not
 * an image). `'transient'` is a host's bad minute (timeout, 5xx, network). Only
 * a transient miss marks the cover `failed`, which keeps it 5 minutes instead of
 * a day: a permanent one would otherwise rebuild the same grid all day long.
 * Measured 2026-11-15 on "ChadF's favorite V4V albums": its third song's cover
 * is 8640 x 8283 (71.6 MP, over IMAGE_PIXEL_LIMIT) and "Christmas" has an RSS
 * Blue song (410), so both grids were held 5 minutes forever.
 */
async function tile(url: string): Promise<Buffer | 'unusable' | 'transient'> {
  let buf: Buffer;
  try {
    buf = await fetchImageBytes(url);
  } catch (e) {
    const status = /image fetch (\d+)/.exec(e instanceof Error ? e.message : '')?.[1];
    return status === '404' || status === '410' ? 'unusable' : 'transient';
  }
  try {
    return await sharp(buf, { limitInputPixels: IMAGE_PIXEL_LIMIT })
      .resize(COVER_SIZE / 2, COVER_SIZE / 2, { fit: 'cover' })
      .flatten({ background: COVER_BG })
      .png()
      .toBuffer();
  } catch {
    // The same bytes fail the same way next time: too many pixels, or not an image.
    return 'unusable';
  }
}

/** The 2 x 2 grid of the first four songs' art. Tiles are decoded one after another (memory). */
async function buildGridCover(songs: PlaylistSong[]): Promise<{ jpg: Buffer; anyTile: boolean; failed: boolean }> {
  const first = songs.slice(0, 4);
  let failed = false;
  let urls: (string | null)[] = [];
  try {
    const eps = first.length ? await batchEpisodes(first) : {};
    // An absent key means Podcast Index could not be asked: that is a failure, not "no art".
    if (first.some((s) => !(episodeKey(s) in eps))) failed = true;
    urls = first.map((s) => {
      const e = eps[episodeKey(s)];
      return e?.image ?? e?.feedImage ?? null;
    });
  } catch {
    failed = true;
    urls = first.map(() => null);
  }
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
