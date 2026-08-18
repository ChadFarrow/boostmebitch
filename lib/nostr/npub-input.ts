import { nip19 } from 'nostr-tools';

/**
 * What a user typed, resolved to a canonical npub.
 *
 * Shared by the home-page lookup box and the `/npub/[npub]` route, so the two
 * cannot disagree about what counts as valid — the box would send someone to a
 * page that then refuses the same string.
 */
export interface ParsedNpubInput {
  npub: string;
  pubkey: string;
}

/**
 * Accept an npub, an nprofile, either behind a `nostr:` URI, a bare 64-char hex
 * pubkey, or any of those as the last segment of a pasted profile URL
 * (njump.me/npub1…, primal.net/p/npub1…). Returns null for anything else.
 *
 * The URL case is not a nicety: pasting a profile link is what people actually
 * do, and the alternative is an error message for a string that plainly names
 * the right person. It is done by string surgery here rather than by importing
 * `lib/pi.ts`'s URI helper, because that module reads `process.env` and
 * `node:crypto` and must never reach the browser.
 *
 * An `nprofile`'s relay hints are deliberately DROPPED rather than carried into
 * a query. They arrive from the URL bar, so they are attacker-supplied, and the
 * only safe use would need `sanitizeRelays` plus a cap — for a lookup that
 * already works against the default relays, that is risk bought for nothing.
 *
 * NIP-05 (`name@domain`) is rejected. Resolving one is a live fetch to a
 * third-party domain, which is a separate feature with its own SSRF surface;
 * the input's placeholder says so rather than failing silently.
 *
 * A bare 64-char hex string is taken as a pubkey and CANNOT be told from an
 * event id — the two are the same shape. So a pasted event id resolves to a
 * person who does not exist and both panels come back empty. The bech32 forms
 * (`note1…`, `nevent1…`) are rejected properly; only the hex form is ambiguous,
 * and there is nothing on the wire to disambiguate it with.
 */
export function parseNpubInput(raw: string): ParsedNpubInput | null {
  let token = raw.trim();
  if (!token) return null;
  // A pasted profile URL: drop the query and hash BEFORE taking the last path
  // segment, and drop a trailing slash. `primal.net/p/npub1…?ref=x` and
  // `njump.me/npub1…/` are both ordinary profile links — the first kept the
  // query string and failed the bech32 decode, the second gave an empty last
  // segment and returned null. Handling a pasted link is the reason this
  // function does string surgery at all, so it has to handle the real shapes.
  token = token.split(/[?#]/)[0].replace(/\/+$/, '');
  const slash = token.lastIndexOf('/');
  if (slash !== -1) token = token.slice(slash + 1);
  // After the path split, so `…/nostr:npub1…` works as well as a bare
  // `nostr:npub1…`.
  token = token.trim().replace(/^nostr:/i, '');
  if (!token) return null;

  try {
    const decoded = nip19.decode(token);
    if (decoded.type === 'npub') {
      return { npub: nip19.npubEncode(decoded.data), pubkey: decoded.data };
    }
    if (decoded.type === 'nprofile') {
      return { npub: nip19.npubEncode(decoded.data.pubkey), pubkey: decoded.data.pubkey };
    }
    return null;
  } catch {
    // Not bech32 — fall through to the hex case.
  }

  if (/^[0-9a-f]{64}$/i.test(token)) {
    const pubkey = token.toLowerCase();
    return { npub: nip19.npubEncode(pubkey), pubkey };
  }
  return null;
}

/**
 * True when the text is, or is trying to be, a SECRET key.
 *
 * This exists because `parseNpubInput` returning null is not a safe default at
 * a call site that falls through to a network request. The home-page box asks
 * for "an npub", people paste the wrong key, and the miss used to go straight
 * to `/api/search?q=…` — which reaches this origin's server logs and then
 * Podcast Index, a third party, with the user's spending and signing key in a
 * URL. A key that has been mailed to a third party is burnt; there is no
 * un-sending it, and nothing on screen would have said it happened.
 *
 * So the test is a PREFIX, deliberately loose, and it runs before any decode:
 * a half-typed or truncated `nsec1qq…` is still key material and must not be
 * sent anywhere either. It matches on the human-readable part alone and never
 * decodes, so this function never holds the key it is protecting.
 */
export function looksLikeSecretKey(raw: string): boolean {
  const token = raw.trim().replace(/^nostr:/i, '').toLowerCase();
  return token.startsWith('nsec1') || token.startsWith('ncryptsec1');
}
