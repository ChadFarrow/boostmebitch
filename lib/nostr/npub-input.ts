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
 */
export function parseNpubInput(raw: string): ParsedNpubInput | null {
  let token = raw.trim();
  if (!token) return null;
  // Last path segment, so a pasted profile URL works. Harmless for a bare
  // npub, which contains no slash.
  const slash = token.lastIndexOf('/');
  if (slash !== -1) token = token.slice(slash + 1);
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
