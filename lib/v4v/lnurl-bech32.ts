// The LUD-01 bech32 form of an LNURL (`lnurl1…`), both ways.
//
// A leaf that imports one bare npm package only, so `check:zapreceipt` loads the
// REAL functions under plain Node (scripts/import-free.mjs, `allowBare`).
import { bech32 } from '@scure/base';

/**
 * An LNURL-pay URL in its LUD-01 bech32 form, lowercase, as the `lnurl` tag of a
 * NIP-57 kind:9734 and the `lnurl` parameter of the zap callback carry it.
 *
 * NO LENGTH LIMIT, ON PURPOSE. `bech32.encodeFromBytes` keeps BIP-173's
 * 90-character cap for a segwit address, which holds a URL of 47 bytes at most:
 * `https://primal.net/.well-known/lnurlp/fancyturtle3` encodes to 92 characters
 * and `https://getalby.com/.well-known/lnurlp/sirtjthewrathful` to 100, so every
 * zap to either threw "Length 100 exceeds limit 90" before it asked for an
 * invoice (Chad, 2026-11-25, on beta). LUD-01 sets no limit, and a `lud06` with
 * a query string runs past 150. Pinned by `check:zapreceipt`.
 */
export function encodeLnurl(url: string): string {
  return bech32.encode('lnurl', bech32.toWords(new TextEncoder().encode(url)), false);
}

/**
 * A `lud06` LNURL back to its URL. Any case (LUD-01 recommends upper case for a
 * QR code), no length limit, as above. Refuses a bech32 string that is not an
 * LNURL, rather than fetching whatever its bytes spell.
 */
export function decodeLnurl(lnurl: string): string {
  const lower = lnurl.toLowerCase();
  if (!lower.includes('1')) throw new Error('Not an LNURL (no bech32 separator)');
  const { prefix, words } = bech32.decode(lower as `${string}1${string}`, false);
  if (prefix !== 'lnurl') throw new Error(`Not an LNURL (prefix "${prefix}")`);
  return new TextDecoder().decode(bech32.fromWords(words));
}
