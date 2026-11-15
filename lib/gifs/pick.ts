// The GIF a boost carries, from either source, and the tile the picker draws.
//
// boostmebitch.com picks from gifs.nostr.build and boostmebuddy.com from GIPHY
// (`BRAND.gifSource`). Everything downstream of the picker — the boost
// modals, `<BoostCard>`, the grid — works on these two shapes and never on a
// source's raw answer, and every URL here comes from a builder that takes a
// validated key (`lib/giphy.ts`, `lib/gifs/nostr-build.ts`).

import {
  giphyGifUrl,
  giphyIdFromUrl,
  giphyMp4Url,
  giphyPreviewUrl,
  giphyStillUrl,
  type GifResult,
} from '@/lib/giphy';
import {
  nbAnimUrl,
  nbGifUrl,
  nbKeyFromUrl,
  nbMp4Url,
  nbStillUrl,
  type NbResult,
} from '@/lib/gifs/nostr-build';

/** The picked GIF: which source, and its key there. */
export type GifPick = { src: 'giphy'; id: string } | { src: 'nostrbuild'; key: string };

/** One grid tile. Every URL is rebuilt from the pick's key. */
export interface GifTile {
  pick: GifPick;
  title: string;
  /** The GIF's own shape, for the tile's height before anything loads. */
  width: number;
  height: number;
  /** H.264 — what the tile plays. */
  mp4: string;
  /** Animated WebP — only where H.264 cannot play, or after the video fails. */
  animated: string;
  /** First frame — reduced motion, refused autoplay, the last fallback. */
  still: string;
  /** Blurred placeholder data URI (nostr.build only), else null. */
  lqip: string | null;
  /** A transparent nostr.build GIF's videos with their transparency, else null. */
  alpha: { webm: string | null; hevc: string | null } | null;
}

/** A GIPHY record with no usable size is drawn as a 200×200 square. */
const SQUARE = 200;

export function giphyTile(r: GifResult): GifTile {
  const sized = r.width !== null && r.height !== null;
  return {
    pick: { src: 'giphy', id: r.id },
    title: r.title,
    width: sized ? (r.width as number) : SQUARE,
    height: sized ? (r.height as number) : SQUARE,
    mp4: giphyMp4Url(r.id),
    animated: giphyPreviewUrl(r.id),
    still: giphyStillUrl(r.id),
    lqip: null,
    alpha: null,
  };
}

export function nbTile(r: NbResult): GifTile {
  return {
    pick: { src: 'nostrbuild', key: r.key },
    title: r.title,
    width: r.width,
    height: r.height,
    mp4: nbMp4Url(r.key),
    animated: nbAnimUrl(r.key),
    still: nbStillUrl(r.key),
    lqip: r.lqip,
    alpha: r.transparent && (r.webm || r.hevc) ? { webm: r.webm, hevc: r.hevc } : null,
  };
}

/** The URL that goes on the wire — the boostagram message and the note body. */
export function gifWireUrl(p: GifPick): string {
  return p.src === 'giphy' ? giphyGifUrl(p.id) : nbGifUrl(p.key);
}

/** The ONE animated picture shown for a picked or stored GIF. */
export function gifPreviewUrl(p: GifPick): string {
  return p.src === 'giphy' ? giphyPreviewUrl(p.id) : nbAnimUrl(p.key);
}

/**
 * The pick a stored message's last line names, or null. Only a URL one of the
 * two wire builders makes is recognised — the WHOLE line — so a stored message
 * never puts an arbitrary `src` in a card. Both sources on both deploys: a
 * boost sent before the switch keeps its picture.
 */
export function gifPickFromWireLine(line: string): GifPick | null {
  const id = giphyIdFromUrl(line);
  if (id) return { src: 'giphy', id };
  const key = nbKeyFromUrl(line);
  if (key) return { src: 'nostrbuild', key };
  return null;
}

/** A stable React key / DOM marker for a pick. */
export function gifPickKey(p: GifPick): string {
  return p.src === 'giphy' ? `giphy:${p.id}` : `nostrbuild:${p.key}`;
}
