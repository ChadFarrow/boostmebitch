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
// a bare image URL as a picture; boostagram readers get a link.
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
 * A still first frame, ~10 KB, for the picker grid.
 *
 * Stills and not the animated renditions: an animated 200px tile is ~300 KB,
 * and a grid of 24 is several megabytes pulled while the user's episode is
 * streaming on the same connection. One animated preview — the picked GIF —
 * is shown at a time.
 */
export function giphyStillUrl(id: string): string {
  return `https://media.giphy.com/media/${id}/200w_s.gif`;
}

/** The animated 200px-wide WebP shown for the ONE GIF the user picked. */
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
 * GIPHY's content rating for a deploy. The family-friendly brand asks for `g`
 * only; the other for `pg-13`. GIPHY applies the filter server-side, so this is
 * what decides which GIFs can be offered at all.
 */
export function giphyRating(brandId: string): 'g' | 'pg-13' {
  return brandId === 'buddy' ? 'g' : 'pg-13';
}

/** One row the picker can render — nothing else from GIPHY's record survives. */
export interface GifResult {
  id: string;
  title: string;
}

/**
 * GIPHY's `{ data: [...] }`, reduced to ids and titles.
 *
 * An ALLOWLIST of two fields: every URL the picker renders is rebuilt from a
 * validated id, so nothing GIPHY returns reaches an `src` as-is. A record with
 * no valid id is dropped rather than repaired.
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
    out.push({ id, title });
  }
  return out;
}
