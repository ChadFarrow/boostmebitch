// An LNURL in its LUD-01 bech32 form (`lnurl1…`), in both directions.
//
// A leaf: it imports one bare npm package and nothing relative, so
// `check:zapreceipt` loads the REAL functions under plain Node
// (scripts/import-free.mjs, `allowBare`). `lib/v4v/zap.ts` cannot load there.
import { bech32 } from '@scure/base';

/**
 * The bech32 form of an LNURL-pay URL, lower case: what a NIP-57 kind:9734
 * carries in its `lnurl` tag and the zap callback in its `lnurl` parameter.
 *
 * NO LENGTH LIMIT. `bech32.encodeFromBytes` (and `encode` with no third
 * argument) keeps BIP-173's 90-character cap for a segwit address. An LNURL is
 * 12 characters plus 8 for every 5 bytes of URL, so the cap admits a URL of 48
 * bytes at most: a Lightning address whose name and domain together pass 20
 * characters overruns it. `https://getalby.com/.well-known/lnurlp/sirtjthewrathful`
 * encodes to 100 characters, and a read-only survey of providers (2026-11-25)
 * found Wallet of Satoshi at 107 and npub.cash at 172. Each zap to one threw
 * "Length 100 exceeds limit 90" before it asked for an invoice. LUD-01 sets no
 * limit. Pinned by `check:zapreceipt`.
 */
export function encodeLnurl(url: string): string {
  return bech32.encode('lnurl', bech32.toWords(new TextEncoder().encode(url)), false);
}

/**
 * A `lud06` back to the URL it encodes. Either case (LUD-01 writes upper case
 * for a QR code), and no length limit, for the reason above: the `false` is
 * explicit because `@scure/base` is not a direct dependency of this app, and the
 * default of `decode` is 90. A valid bech32 string with another prefix (an
 * `npub`, a `note`) is refused here, so its bytes are never fetched as a URL.
 */
export function decodeLnurl(lnurl: string): string {
  const lower = lnurl.trim().toLowerCase();
  const sep = lower.lastIndexOf('1');
  if (sep < 1) throw new Error('Not an LNURL: no bech32 separator');
  const { prefix, words } = bech32.decode(lower as `${string}1${string}`, false);
  if (prefix !== 'lnurl') throw new Error(`Not an LNURL: the prefix is "${prefix}"`);
  return new TextDecoder().decode(bech32.fromWords(words));
}
