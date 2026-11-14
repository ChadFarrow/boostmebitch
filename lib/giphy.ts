// GIPHY: the GIF a boost can carry.
//
// NO IMPORTS, on purpose — the server route (`app/api/gifs`) and the boost
// modals both read this, and a leaf is the one shape both sides of the
// server/client boundary can import without dragging the other along.
//
// WHAT A PICKED GIF BECOMES ON THE WIRE: one URL, appended to the boost
// message. That single string is the boostagram's `message` (TLV 7629169, and
// the LNURL comment) AND the note body `formatContent` writes, so the note and
// the boostagram cannot disagree about which GIF was sent. Note readers render
// a bare image URL as a picture.
//
// THE URL IS BUILT FROM THE ID, NEVER COPIED FROM THE API. GIPHY's API returns
// renditions like `media2.giphy.com/media/v1.Y2lk…/giphy.gif?cid=…&rid=…`: well
// over 100 characters of tracking parameters, against a 250-character keysend
// budget the user's own words share. The canonical form below is ~60, ends in
// `.gif` (which `isImageUrl` and every note reader key on), and carries
// nothing about the session that picked it. A kind:1 cannot be edited, so the
// short permanent form is the one that matters.

/**
 * A GIPHY id: the alphanumeric slug in every media URL. Validated before it is
 * ever put into one, so an id from the API — third-party data — cannot steer
 * the URL a note publishes forever.
 */
const GIPHY_ID_RE = /^[A-Za-z0-9]{4,64}$/;

export function isGiphyId(id: unknown): id is string {
  return typeof id === 'string' && GIPHY_ID_RE.test(id);
}

/** The full animated GIF — the URL that goes on the wire. */
export function giphyGifUrl(id: string): string {
  return `https://media.giphy.com/media/${id}/giphy.gif`;
}

/**
 * H.264, 200 px wide — what a picker grid tile plays (`<GifGrid>`). 12–50 KB
 * for seven of eight real ids (196 KB for the eighth), Main or Constrained
 * Baseline, `yuv420p`, level 3.0: what every iPhone Safari plays.
 */
export function giphyMp4Url(id: string): string {
  return `https://media.giphy.com/media/${id}/200w.mp4`;
}

/**
 * A still first frame, ~10–20 KB: a grid tile under reduced motion or a
 * refused autoplay, and the last fallback when its video fails.
 */
export function giphyStillUrl(id: string): string {
  return `https://media.giphy.com/media/${id}/200w_s.gif`;
}

/**
 * The animated 200px-wide WebP (24–870 KB): the GIF the user picked, a stored
 * boost's GIF, and a grid tile only when this browser cannot play H.264.
 */
export function giphyPreviewUrl(id: string): string {
  return `https://media.giphy.com/media/${id}/200w.webp`;
}

/** The id inside a URL {@link giphyGifUrl} built, or null for anything else. */
export function giphyIdFromUrl(url: string): string | null {
  const m = /^https:\/\/media\.giphy\.com\/media\/([A-Za-z0-9]+)\/giphy\.gif$/.exec(url);
  return m && isGiphyId(m[1]) ? m[1] : null;
}

/**
 * The boost message with the GIF on its own line after the prose.
 *
 * After, not before: `buildLnurlComment` keeps whole URLs only, so a GIF that
 * does not fit a tight `commentAllowed` is dropped while the words survive.
 * One newline is all it costs against the budget — see {@link gifCost}.
 *
 * With no GIF the message is returned UNCHANGED, so a boost without one puts
 * exactly the bytes on the wire it did before this existed.
 */
export function withGif(message: string, gifUrl: string | null): string {
  if (!gifUrl) return message;
  const prose = message.trim();
  return prose ? `${prose}\n${gifUrl}` : gifUrl;
}

/** How many characters of the boostagram budget a picked GIF takes. */
export function gifCost(gifUrl: string | null): number {
  return gifUrl ? gifUrl.length + 1 : 0;
}

/**
 * GIPHY's content rating for a deploy. GIPHY applies the filter server-side, so
 * this is what decides which GIFs can be offered at all.
 *
 * BOTH deploys ask for `pg-13`. Buddy asked for `g` until 2026-11-14, and `g`
 * did not hold: GIPHY rates its own GIFs, and a `g` search on boostmebuddy.com
 * that day returned six middle fingers in eight for "middle finger" and a
 * topless "sexy twerk" GIF for "sexy" — both rated `g` on giphy.com. Chad's
 * call: "if anyone is using Buddy I assume they are over 13". So the family
 * site's GIFs are now exactly the main site's; anything stricter has to be a
 * filter of our own, because GIPHY's lowest rating is not one.
 *
 * Named the other way round on purpose: a brand id this does not know gets `g`,
 * so a third deploy starts at the strictest rating rather than inheriting
 * `pg-13`.
 */
export function giphyRating(brandId: string): 'g' | 'pg-13' {
  return brandId === 'bmb' || brandId === 'buddy' ? 'pg-13' : 'g';
}

/** One row the picker can render — nothing else from GIPHY's record survives. */
export interface GifResult {
  id: string;
  title: string;
  /** The 200w rendition's size, so a tile has its shape before it loads. */
  width: number | null;
  height: number | null;
}

/** GIPHY sends sizes as strings ("200"). An integer 1–4096, else null. */
function giphyDim(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 4096 ? n : null;
}

/**
 * GIPHY's `{ data: [...] }`, reduced to ids, titles and sizes.
 *
 * An ALLOWLIST: every URL the picker renders is rebuilt from a validated id,
 * so nothing GIPHY returns reaches an `src` as-is. A record with no valid id is
 * dropped rather than repaired. Sizes come from `images.fixed_width`, else
 * `images.original`; a record with neither is KEPT with null sizes — the grid
 * draws it square — because no key on a dev machine has ever shown which
 * renditions the `messaging_non_clips` bundle carries, and dropping an
 * unsized record could empty every search.
 */
export function parseGiphyResults(json: unknown): GifResult[] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: GifResult[] = [];
  const seen = new Set<string>();
  for (const row of data) {
    const id = (row as { id?: unknown } | null)?.id;
    if (!isGiphyId(id) || seen.has(id)) continue;
    seen.add(id);
    const rawTitle = (row as { title?: unknown }).title;
    const title = typeof rawTitle === 'string' ? rawTitle.trim().slice(0, 120) : '';
    const images = (row as { images?: Record<string, { width?: unknown; height?: unknown } | undefined> }).images;
    let width: number | null = null;
    let height: number | null = null;
    for (const r of [images?.fixed_width, images?.original]) {
      const w = giphyDim(r?.width);
      const h = giphyDim(r?.height);
      if (w !== null && h !== null) { width = w; height = h; break; }
    }
    out.push({ id, title, width, height });
  }
  return out;
}
