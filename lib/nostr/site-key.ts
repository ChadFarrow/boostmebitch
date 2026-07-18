// SERVER-ONLY. Resolves the site's own Nostr key from the SITE_NOSTR_SK env
// var (nsec or 32-byte hex). Never import this from client code — it reads a
// server-only secret. Used by the site-sign route (boost notes for signed-out
// users) and the /.well-known/nostr.json NIP-05 route, so both derive the same
// identity from one source and can't drift.
import { getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';

/** The site secret key bytes, or null when unset/malformed (feature off). */
export function siteSecretKey(): Uint8Array | null {
  const raw = process.env.SITE_NOSTR_SK?.trim();
  if (!raw) return null;
  try {
    if (raw.startsWith('nsec1')) {
      const decoded = nip19.decode(raw);
      return decoded.type === 'nsec' ? decoded.data : null;
    }
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) return null;
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  } catch {
    return null;
  }
}

/** The site public key (hex), or null when the key is unset/malformed. */
export function sitePubkey(): string | null {
  const sk = siteSecretKey();
  return sk ? getPublicKey(sk) : null;
}
