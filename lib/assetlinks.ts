// Digital Asset Links — the statement that authorizes ONE Android package to
// speak for this origin.
//
// The Android app is a Trusted Web Activity: a signed shell that opens
// www.boostmebitch.com full-screen. Chrome only drops the URL bar if it fetches
// https://<host>/.well-known/assetlinks.json and finds a statement naming the
// running package AND the SHA-256 fingerprint of the certificate that signed
// it. See docs/android.md.
//
// WHY THIS IS A SEPARATE, IMPORT-FREE MODULE AND NOT INLINE IN THE ROUTE:
//
// Both ways this payload can be wrong are SILENT.
//
//   - Malformed fingerprint, wrong case, a stray space: verification fails and
//     the app shows a URL bar. No error is logged anywhere, on the device or
//     the server — the app just quietly looks like a browser.
//   - Wrong or over-permissive target: a statement is a grant. `package_name`
//     with no fingerprints, or a fingerprint list we didn't mean, hands another
//     package the right to represent this origin — and this origin's
//     localStorage holds an NWC spending credential.
//
// So the payload is built by a pure function that plain Node can load, and
// `npm run check:assetlinks` pins it against the real module. Keep this file
// free of imports — see scripts/import-free.mjs for why even a type-only
// relative import breaks that arrangement.

export type AssetLinkStatement = {
  relation: string[];
  target: {
    namespace: 'android_app';
    package_name: string;
    sha256_cert_fingerprints: string[];
  };
};

/** The only relation a TWA needs: "this app may handle every URL on my site". */
const RELATION = 'delegate_permission/common.handle_all_urls';

// Java package syntax, which is what an Android applicationId is: dot-separated
// segments, each starting with a letter or underscore. Deliberately NOT a
// loose `[\w.]+` — this string is interpolated into a JSON grant, and the point
// of validating it is that an unexpected shape produces NO statement rather
// than a statement about something we didn't mean.
const PACKAGE_ID = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const MAX_PACKAGE_ID_LEN = 255;

/**
 * Canonical form of a SHA-256 certificate fingerprint, or `null` if the input
 * isn't one.
 *
 * Accepts what a human actually has in hand — `keytool -list` prints
 * uppercase colon-separated hex, `apksigner` and most CI snippets print bare
 * lowercase hex — and emits the single form Chrome compares against:
 * 32 uppercase hex byte-pairs joined by colons.
 *
 * Being liberal about the INPUT is not the same as being liberal about the
 * output. A 31-byte value, a 33-byte value, or anything non-hex is `null`,
 * because a fingerprint that isn't exactly 32 bytes cannot match any
 * certificate and only serves to make the served file look configured.
 */
export function normalizeFingerprint(raw: string): string | null {
  const compact = raw.replace(/[\s:]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(compact)) return null;
  return (compact.match(/.{2}/g) as string[]).join(':');
}

/**
 * Build the statement list served at /.well-known/assetlinks.json.
 *
 * Returns `[]` — a valid, well-formed "no app is authorized" answer — when the
 * package id is missing or malformed, or when NOTHING in `fingerprints`
 * survives normalization. That empty case is the one this repo cares most
 * about: an unconfigured deploy must publish no grant at all, and it must
 * never publish a statement carrying an empty `sha256_cert_fingerprints`
 * array, which reads as a target with the fingerprint check switched off.
 *
 * `fingerprints` may be a comma-separated string (how the environment carries
 * it) or a list. More than one is normal, not decorative: a key rotation needs
 * the outgoing and incoming fingerprints live at the same time, and the app
 * you already shipped is signed by the outgoing one.
 */
export function buildAssetLinks(
  packageId: string | undefined,
  fingerprints: string | readonly string[] | undefined,
): AssetLinkStatement[] {
  const pkg = (packageId ?? '').trim();
  if (!pkg || pkg.length > MAX_PACKAGE_ID_LEN || !PACKAGE_ID.test(pkg)) return [];

  const raw = typeof fingerprints === 'string' ? fingerprints.split(',') : (fingerprints ?? []);
  const seen = new Set<string>();
  for (const entry of raw) {
    const fp = normalizeFingerprint(entry);
    // A bad entry is dropped rather than failing the whole list: during a
    // rotation the list is edited by hand, and losing verification for the
    // key that IS valid because a second one was mistyped is the worse
    // outcome. Nothing malformed reaches the wire either way.
    if (fp) seen.add(fp);
  }
  if (!seen.size) return [];

  return [{
    relation: [RELATION],
    target: {
      namespace: 'android_app',
      package_name: pkg,
      sha256_cert_fingerprints: [...seen],
    },
  }];
}
