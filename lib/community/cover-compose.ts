import sharp from 'sharp';

// Pure image composition for a community playlist's cover. Its only import is
// the npm package `sharp`, so a check script can load it (see check:community).

export const COVER_SIZE = 1400;
const HALF = COVER_SIZE / 2;
export const COVER_BG = '#0A0A08';
export const COVER_ACCENT = '#FAE500';
export const COVER_JPEG = { quality: 85, mozjpeg: true } as const;

/**
 * A beamed pair of eighth notes drawn from shapes only (two ellipses, two
 * stems, one beam). No `<text>`: librsvg needs a font for that, and the
 * serverless runtime may have none. Centred on the canvas.
 */
export function noteSvg(): string {
  const f = COVER_ACCENT;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${COVER_SIZE}" height="${COVER_SIZE}">`
    + `<g transform="translate(-27,0)" fill="${f}">`
    + `<ellipse cx="530" cy="960" rx="130" ry="95" transform="rotate(-20 530 960)"/>`
    + `<ellipse cx="910" cy="880" rx="130" ry="95" transform="rotate(-20 910 880)"/>`
    + `<rect x="630" y="430" width="44" height="530"/>`
    + `<rect x="1010" y="350" width="44" height="530"/>`
    + `<polygon points="630,430 1054,350 1054,490 630,570"/>`
    + `</g></svg>`;
}

/** The 2 x 2 tiles (each 700 x 700) on the dark canvas; a missing tile repeats the previous; none gives the note. */
export async function composeCover(tiles: (Buffer | null)[]): Promise<Buffer> {
  const canvas = sharp({ create: { width: COVER_SIZE, height: COVER_SIZE, channels: 3, background: COVER_BG } });
  let prev = tiles.find((t) => t) ?? null;
  if (!prev) {
    return canvas.composite([{ input: Buffer.from(noteSvg()), top: 0, left: 0 }]).jpeg(COVER_JPEG).toBuffer();
  }
  const spots = [[0, 0], [HALF, 0], [0, HALF], [HALF, HALF]];
  const layers = spots.map(([left, top], i) => {
    const t = tiles[i] ?? prev;
    if (t) prev = t;
    return { input: t as Buffer, left, top };
  });
  return canvas.composite(layers).jpeg(COVER_JPEG).toBuffer();
}
