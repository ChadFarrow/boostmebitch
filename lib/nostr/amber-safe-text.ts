// ---------------------------------------------------------------------------
// A text encoding that survives Amber's `nostrsigner:` parser unchanged.
//
// Kept IMPORT-FREE so `npm run check:ambersafe` can load this exact module
// under `node --experimental-strip-types` — see scripts/import-free.mjs.
// Nothing here may import anything, type-only included.
//
// ## Why this exists
//
// Amber URL-decodes the WHOLE `nostrsigner:` URI and only then splits it, on
// `?` first. So percent-encoding the payload does not protect it: a `%3F` we
// wrote becomes a literal `?` in Amber's hands and the request is truncated
// there. Measured on 6.3.0 and again on 6.5.2 — the request comes back
// "Invalid request. Amber received a malformed nostrsigner request."
// docs/signers.md carries the full measurement.
//
// Two payload classes hit it STRUCTURALLY, not occasionally, and this module
// holds a fix for each:
//
//  - An NWC connection string. NIP-47 writes
//    `nostr+walletconnect://<pubkey>?relay=…&secret=…`, so EVERY NWC backup
//    carries one and EVERY NWC backup attempt on Amber failed. `encodeAmberSafe`
//    fixes it, and may, because we own both ends of that plaintext: nothing but
//    this app ever reads it.
//  - A boost note. `formatContent` (lib/nostr/boost-notes.ts) writes the
//    in-app link `…/?podcast=<guid>` and the banner `…/api/og/boost.png?art=…`
//    into EVERY note, so every boost note signed through Amber came back
//    "Invalid request" — measured 2026-09-03 on a Pixel, on the screen the user
//    photographed. `escapeJsonForAmber` fixes it, and it has to be a DIFFERENT
//    fix: a signed event and a shared private list are read by other apps, so
//    the bytes must stay plain JSON. Item guids that are permalink URLs, a
//    profile `website`, a typed message ending in `?` — all the same class.
//
// ## The encoding
//
//     bmb1.<base64url of the UTF-8 bytes>
//
// Every character of the output — `b`, `m`, `1`, `.`, and the base64url
// alphabet `A-Za-z0-9-_` — is in the set `encodeURIComponent` leaves alone. So
// the encoded text is a FIXED POINT of percent-encoding:
//
//     encodeURIComponent(encodeAmberSafe(x)) === encodeAmberSafe(x)
//
// which is the property that matters. It is not merely "there is no `?` in it
// today"; no encode/decode pass anywhere in the chain — ours, the browser's,
// Amber's — can turn it into a character Amber's splitter reacts to. A future
// Amber that splits on some other delimiter is covered too, because the
// delimiter would have to be a character no unreserved-only string contains.
//
// ## Reading, and the legacy format
//
// Backups written before this shipped hold bare JSON. `decodeAmberSafe`
// returns null for anything not carrying the prefix, which is the reader's
// signal to treat the text as legacy and parse it directly — see
// `fetchEncryptedNwc`. Null is "not this format", never "corrupt": the caller
// still has a plaintext to try.
// ---------------------------------------------------------------------------

/** Marks a plaintext as carrying this encoding. Unreserved characters only. */
export const AMBER_SAFE_PREFIX = 'bmb1.';

/** The characters base64url uses. Nothing outside it may reach the decoder. */
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!BASE64URL_RE.test(text)) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (text.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    // A length ≡ 1 (mod 4) body is not decodable. Not our format.
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Encode `text` so no parser between here and the signer can alter it.
 *
 * Use it for any plaintext handed to `nip44.encrypt` whose content this app
 * chooses — the NWC connection string is the one that needs it today. Do NOT
 * use it on an event template: a signed event must be signed over the exact
 * bytes the relay will verify.
 */
export function encodeAmberSafe(text: string): string {
  return AMBER_SAFE_PREFIX + toBase64Url(new TextEncoder().encode(text));
}

/**
 * The original text, or null if `encoded` does not carry this encoding.
 *
 * Null covers both "written before this shipped" and "not ours at all"; the
 * caller decides what to do with the raw plaintext it still holds.
 */
export function decodeAmberSafe(encoded: string): string | null {
  if (!encoded.startsWith(AMBER_SAFE_PREFIX)) return null;
  const bytes = fromBase64Url(encoded.slice(AMBER_SAFE_PREFIX.length));
  if (!bytes) return null;
  try {
    // `fatal` so invalid UTF-8 is rejected rather than silently replaced with
    // U+FFFD — a mangled connection string that still parses is worse than one
    // that reports itself missing.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Write every `?` in a JSON text as its JSON escape `\u003f`.
 *
 * Lossless by construction: `JSON.parse` of the result is the same value as
 * `JSON.parse` of the input, in every implementation, because `\u003f` IS `?`
 * to a JSON reader. That is what lets a signed event, a mute list's private
 * half or a favorites private half go through Amber and still be read by
 * every other app — `encodeAmberSafe` is the wrong tool for those, since a
 * `bmb1.` prefix inside a kind:1 is a note nobody can read.
 *
 * Safe as a GLOBAL replace over stringified JSON: `?` is not a structural
 * character (`{}[]:,"`), so it only ever appears inside a string literal. A `?`
 * after a backslash is after an ESCAPED backslash — `JSON.stringify` writes
 * `\\` — so the escape lands after it correctly. `JSON.stringify` never emits
 * `\u003f` itself, so the input carries none the replace could double up.
 *
 * Use it on the text handed to Amber for `sign_event`, and on any JSON
 * plaintext handed to `nip04_encrypt` / `nip44_encrypt`. It is NOT for a
 * plaintext that is not JSON — `\u003f` there is six literal characters, and
 * `encodeAmberSafe` is the answer. The same escape is written by hand in
 * `encodePrivateFavorites` (lib/nostr/favorites-list.ts), which cannot import
 * this leaf and stay import-free itself; keep the two in step.
 */
export function escapeJsonForAmber(json: string): string {
  return json.replace(/\?/g, '\\u003f');
}
