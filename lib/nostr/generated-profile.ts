'use client';

// Name and avatar for accounts this app created itself (the Google onboarding
// path). Both are derived ONLY from the pubkey — deliberately not from the
// Google account.
//
// Copying the user's Google name and photo would need the `profile` OAuth
// scope and would publish a permanent, public link between their real-world
// identity and their npub. That is precisely the linkage the appDataFolder
// design was chosen to avoid: Google is a blob store here, not an identity
// provider. Deriving from the pubkey keeps that true.
//
// Pure and deterministic: same pubkey, same output, forever. No I/O.

import { ADJECTIVES, NOUNS } from './profile-words';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Amber Otter" — stable for a given pubkey. */
export function generatedName(pubkey: string): string {
  const adj = ADJECTIVES[parseInt(pubkey.slice(0, 4), 16) % ADJECTIVES.length];
  const noun = NOUNS[parseInt(pubkey.slice(4, 8), 16) % NOUNS.length];
  return `${cap(adj)} ${cap(noun)}`;
}

// A 5x5 identicon mirrored on the vertical axis: 15 independent cells (5 rows
// x 3 columns), columns 3-4 mirroring columns 1-0.
const CELL_COUNT = 15;
// Bits come from a window disjoint from the hue's slice(0,6). If both read the
// same bytes, pattern and colour would correlate and similar-hued accounts
// would tend to look alike — the opposite of what an identicon is for.
const BIT_WINDOW: [number, number] = [8, 24];
// A pubkey whose bits land nearly all-zero or all-one yields a blank or solid
// tile: valid, but a useless avatar and a bad first impression on an account
// the user didn't choose the look of. Fall back to a fixed pleasant pattern.
const MIN_CELLS = 3;
const MAX_CELLS = 12;
const FALLBACK_BITS = 0b010110101101010;

function popcount(n: number): number {
  let c = 0;
  for (let v = n; v; v >>= 1) c += v & 1;
  return c;
}

/** Deterministic identicon as a self-contained data: URI. */
export function generatedAvatarDataUri(pubkey: string): string {
  const hue = parseInt(pubkey.slice(0, 6), 16) % 360;
  const window = BigInt(`0x${pubkey.slice(BIT_WINDOW[0], BIT_WINDOW[1])}`);
  let bits = Number(window & 0x7fffn);
  if (popcount(bits) < MIN_CELLS || popcount(bits) > MAX_CELLS) bits = FALLBACK_BITS;

  const cells: string[] = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    if (!(bits & (1 << i))) continue;
    const row = Math.floor(i / 3);
    const col = i % 3;
    cells.push(`<rect x="${col}" y="${row}" width="1" height="1"/>`);
    // Column 2 is the centre line — mirroring it would double-draw.
    if (col < 2) cells.push(`<rect x="${4 - col}" y="${row}" width="1" height="1"/>`);
  }

  // Same hue derivation as <DefaultAvatar>, so the published avatar and this
  // app's own fallback tile never read as two different people.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" shape-rendering="crispEdges">` +
    `<rect width="5" height="5" fill="hsl(${hue},45%,28%)"/>` +
    `<g fill="hsl(${hue},55%,72%)">${cells.join('')}</g>` +
    `</svg>`;
  // ASCII-only by construction, so btoa needs no unicode handling.
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** The kind:0 content for a freshly generated account. */
export function buildGeneratedProfile(pubkey: string) {
  const name = generatedName(pubkey);
  return { name, display_name: name, picture: generatedAvatarDataUri(pubkey) };
}
