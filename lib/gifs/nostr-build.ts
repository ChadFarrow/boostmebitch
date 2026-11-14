// nostr.build's GIF API (gifs.nostr.build): the GIF source boostmebitch.com
// searches. boostmebuddy.com keeps GIPHY (`lib/giphy.ts`).
//
// NO IMPORTS, on purpose — `scripts/e2e-gif-grid.mjs --pure` loads this exact
// module under plain Node.
//
// THE SAME POSTURE AS GIPHY: EVERY URL IS REBUILT FROM A VALIDATED KEY. An API
// answer is third-party data, so nothing it sends reaches an `src` or a CSS
// `url(...)` as-is. A result whose own URLs differ from the ones rebuilt here
// is DROPPED, not repaired: a mismatch means the answer is not the shape this
// code was written against, and guessing which half to trust is how a
// foreign URL ends up in a note that can never be edited.
//
// THE KEY IS THE FILE NAME, NOT `id`. In 40 real results (2026-11-14) one had
// an `id` different from the file its `url`, `mp4` and previews all name. So
// the key is read from `url`'s last path segment, and every other URL must
// carry that same key.
//
// Browser calls send NO custom headers: the API admits a website by its
// registered Origin, and an `Authorization` header fails the CORS preflight
// (https://gifs.nostr.build/developers/llms-full.txt, section 1).

export const NB_BASE = 'https://gifs.nostr.build';

/** A file key: 64 hex, optionally `nostr.build_`-prefixed, `.gif` or `.webp`. */
const KEY_RE = /^(nostr\.build_)?[0-9a-f]{64}\.(gif|webp)$/;

export function isNbKey(s: unknown): s is string {
  return typeof s === 'string' && KEY_RE.test(s);
}

/** The original — what goes on the wire. 93 characters (105 prefixed). */
export function nbGifUrl(key: string): string {
  return `${NB_BASE}/${key}`;
}

/** H.264 at source size, what a grid tile plays. Ends in `.gif` on purpose. */
export function nbMp4Url(key: string): string {
  return `${NB_BASE}/mp4/orig/${key}`;
}

/** Animated WebP fitted to 240 px wide (a `.gif` name, WebP bytes). */
export function nbAnimUrl(key: string): string {
  return `${NB_BASE}/anim/w240/${key}`;
}

/** First frame, PNG, fitted to 240 px wide. */
export function nbStillUrl(key: string): string {
  return `${NB_BASE}/still/w240/${key}`;
}

/** The key inside a URL {@link nbGifUrl} built — the WHOLE string — else null. */
export function nbKeyFromUrl(url: string): string | null {
  const prefix = `${NB_BASE}/`;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  return isNbKey(rest) ? rest : null;
}

/** The API refuses `q` over 500 characters with a 400. */
const MAX_QUERY = 500;

/**
 * The query as it is searched, or null when it is not a search: empty, or a
 * single Latin letter (the guide's rule — one emoji or ideograph IS a search,
 * the API searches an emoji by its name). Trimmed, spaces collapsed,
 * lowercased, and cut between characters, never inside an emoji.
 */
export function normalizeNbQuery(q: string): string | null {
  const s = q.trim().replace(/\s+/g, ' ').toLowerCase();
  const chars = graphemes(s);
  if (chars.length === 0) return null;
  if (chars.length === 1 && /^[\p{Script=Latin}\p{ASCII}]$/u.test(chars[0])) return null;
  let out = '';
  let n = 0;
  for (const c of chars) {
    const len = [...c].length;
    if (n + len > MAX_QUERY) break;
    out += c;
    n += len;
  }
  return out;
}

function graphemes(s: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), (x) => x.segment);
  }
  return [...s];
}

/** One request per query, the whole ranked list (at most 200) at once. */
export function nbSearchUrl(q: string): string {
  return `${NB_BASE}/api/v1/search?q=${encodeURIComponent(q)}&limit=200`;
}

/**
 * What an empty box shows. nostr.build has no trending list; `kind=reaction`
 * is its daily-shuffled browse of reaction GIFs, the nearest thing to it.
 */
export const NB_BROWSE_URL = `${NB_BASE}/api/v1/gifs?kind=reaction&limit=200`;

/** One result the picker can draw — nothing else from the record survives. */
export interface NbResult {
  key: string;
  title: string;
  width: number;
  height: number;
  /** A tiny blurred placeholder, `data:image/…;base64,…` only, else null. */
  lqip: string | null;
  /** A transparent GIF as VP9 / HEVC video with its transparency, else null. */
  webm: string | null;
  hevc: string | null;
  transparent: boolean;
}

/** It goes into a CSS `url(...)`, so anything but this shape could inject CSS. */
const LQIP_RE = /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/;

const MAX_DIM = 4096;

function dim(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_DIM ? n : null;
}

/** Our host, and no `#`: the tile adds `#t=0.001`, and a `#` of its own breaks that. */
function alphaVideo(v: unknown): string | null {
  return typeof v === 'string' && v.startsWith(`${NB_BASE}/`) && !v.includes('#') ? v : null;
}

/** A search or browse answer (`{ items: [...] }`), reduced to {@link NbResult}s. */
export function parseNbResults(json: unknown): NbResult[] {
  const items = (json as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: NbResult[] = [];
  const seen = new Set<string>();
  for (const row of items) {
    if (!row || typeof row !== 'object') continue;
    const g = row as Record<string, unknown>;
    const key = typeof g.url === 'string' ? nbKeyFromUrl(g.url) : null;
    if (!key || seen.has(key)) continue;
    const w240 = (g.previews as { w240?: { animated?: unknown; still?: unknown } } | undefined)?.w240;
    if (g.mp4 !== nbMp4Url(key) || w240?.animated !== nbAnimUrl(key) || w240?.still !== nbStillUrl(key)) continue;
    const width = dim(g.width);
    const height = dim(g.height);
    if (width === null || height === null) continue;
    seen.add(key);
    out.push({
      key,
      title: typeof g.title === 'string' ? g.title.trim().slice(0, 120) : '',
      width,
      height,
      lqip: typeof g.lqip === 'string' && LQIP_RE.test(g.lqip) ? g.lqip : null,
      webm: alphaVideo(g.webm),
      hevc: alphaVideo(g.hevc),
      transparent: typeof g.transparency === 'number' && g.transparency > 0,
    });
  }
  return out;
}
