// The Spark wallet's key derivation, split out of spark.ts so it can be
// imported from plain Node.
//
// Deliberately carries NO `'use client'` directive and NO static imports —
// that's the whole point. spark.ts is client-only and statically imports
// '../pubsub' extensionless, so `node --experimental-strip-types` can't load
// it, and the one function whose silent change costs users their funds would
// have no regression pin. This file has neither problem, so
// scripts/check-spark-derivation.mjs can execute the real production code
// against a frozen vector.
//
// The crypto imports stay dynamic inside the function (as they were in
// spark.ts) so @noble/@scure stay out of the initial browser chunk.
//
// Directive-less is safe: a module with no directive imported by a client
// component is bundled into the client graph normally, and this file is pure
// and isomorphic, so being importable from either side is honest.

/**
 * Derive a wallet mnemonic deterministically from a Nostr secret key, so a
 * user onboarded via Google lands with a working boost rail instead of an
 * empty wallet modal. Mirrors Wisp's "derive default Spark wallet from user's
 * nsec".
 *
 * Deterministic is the point: the wallet is recoverable from the nsec alone,
 * so it survives even if the kind:30078 backup is ever lost. And because this
 * returns an ordinary 12-word BIP-39 phrase, everything downstream —
 * sparkInitFromMnemonic, publishEncryptedMnemonic, the seed-phrase display —
 * is untouched.
 *
 * The HMAC domain-separates the wallet seed from the signing key: the wallet
 * seed can't be walked back to the nsec.
 *
 * ⚠️ THE LABEL IS A DERIVATION CONTRACT — treat `'bmb-spark-wallet'` as v1 and
 * never edit it in place. Changing the label (or the truncation, or the hash)
 * changes every derived wallet, and every user whose funds live in one loses
 * access to them from the same nsec. There is no graceful failure: they simply
 * land on a different, empty wallet. If the derivation ever has to change, add
 * a NEW label (`bmb-spark-wallet-v2`), try v1 first on restore, and migrate
 * balances deliberately. Wisp — where this is ported from — versions its salt
 * (`wisp-spark-wallet-v1`) for exactly this reason and locks the contract with
 * test vectors; ours is unversioned by history, so this comment is the guard.
 *
 * Pinned by `scripts/check-spark-derivation.mjs` — run `npm run check:spark`
 * after ANY edit below. If it fails, you have moved every derived wallet.
 *
 * (Note we are NOT wire-compatible with Wisp and don't try to be: they use
 * HKDF extract+expand with their own salt, we use HMAC-then-truncate with
 * ours. Both are sound; they simply produce different wallets.)
 */
export async function sparkMnemonicFromKey(skHex: string): Promise<string> {
  if (!/^[0-9a-fA-F]{64}$/.test(skHex)) {
    throw new Error('Wallet derivation requires a 32-byte hex secret key');
  }
  const { hmac } = await import('@noble/hashes/hmac.js');
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const { hexToBytes } = await import('@noble/hashes/utils.js');
  const { entropyToMnemonic } = await import('@scure/bip39');
  const { wordlist } = await import('@scure/bip39/wordlists/english.js');

  const full = hmac(sha256, new TextEncoder().encode('bmb-spark-wallet'), hexToBytes(skHex));
  // 16 bytes -> 12 words, matching what the wallet UI shows users to write down.
  return entropyToMnemonic(full.slice(0, 16), wordlist);
}
