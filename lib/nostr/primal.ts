// Primal — the other major mobile signer — and the one string a web client
// needs to hand it a pairing. https://primal.net
//
// IT NEEDS NO NEW MACHINERY, which is the whole reason it earns a row. Primal
// speaks NIP-46 over the SAME `nostrconnect://` URI this app already builds:
// same memoized pairing, same client key, same relays, same `perms`. So it is a
// bunker like Clave and Amber-over-nostrconnect — `storage.signer` stays
// `'bunker'`, `lib/nostr/bunker.ts` carries the transport, and
// `unattendedDecryptOk()` answers `false` for it. What is Primal-specific is
// exactly the launch URL below.
//
// NO IMPORTS, and keep it that way — the same rule `./clave.ts` follows, for
// the same reason: a leaf with no imports can be loaded by a plain-Node script
// if this ever grows something worth pinning.

/** Where to send an Android user who has not got it. */
export const PRIMAL_PLAY_URL =
  'https://play.google.com/store/apps/details?id=net.primal.android';

/**
 * Primal's Android package id, and the reason this file exists at all.
 *
 * ON ANDROID THE RAW SCHEME IS NOT ENOUGH, and that is not a detail. Amber
 * already claims `nostrconnect://`, so dispatching the bare URI opens the OS
 * chooser — which would make the *Amber* row and the *Primal* row do visibly
 * the same thing, one list apart. An explicit-package `intent:` URL names the
 * app, so each row opens the app it is labelled with.
 *
 * Conduit ship exactly this shape (github.com/Conduit-BTC/conduit-mono,
 * `packages/ui/src/components/signer-platform.ts`, `androidSignerConnectUrl`).
 */
export const PRIMAL_ANDROID_PACKAGE = 'net.primal.android';

/**
 * The URL that hands Primal a pairing, or `null` if the URI is not one we are
 * willing to put in a launch link.
 *
 * TWO PLATFORMS, TWO ANSWERS, and the iOS one is the plain scheme on purpose.
 * StableKraft dispatch the bare `nostrconnect://` token there
 * (ChadFarrow/stablekraft-app, `components/Nostr/Nip46Connect.tsx`:
 * `signerApp === 'primal' && isIOS()`), and it works because a custom scheme,
 * unlike a Universal Link, IS dispatched from a scripted navigation. That is
 * the opposite of Clave, whose primary must be a real `<a href>` — see
 * `./clave.ts`. Do not "unify" the two launchers; they differ because the two
 * mechanisms differ.
 *
 * **The query is sliced, never re-encoded.** The pairing URI already carries
 * its own percent-encoded `?relay=…&secret=…&perms=…`, and running it through
 * `URLSearchParams` or `encodeURIComponent` a second time is how a pairing
 * arrives at the signer mangled. Conduit state the rule outright — *"Do not
 * parse or re-encode the query, or include it in an install fallback"* — so
 * this takes the substring after `nostrconnect:` and puts it back verbatim.
 *
 * It returns `null` rather than throwing, and the caller renders no button on
 * `null`. That is a safe default HERE and would not be everywhere: nothing
 * downstream reaches the network with it, so a missing link costs a control,
 * not a mis-addressed pairing.
 */
export function primalConnectUrl(uri: string, android: boolean): string | null {
  // A fragment would be swallowed by the `#Intent;…` separator below, and
  // whitespace or a control character in a launch URL is not something to pass
  // on to the OS. Reject rather than repair: every one of these means the URI
  // did not come from `createNostrConnectURI`, and guessing what was meant is
  // how a launch link stops matching the pairing the page is listening for.
  if (!uri.startsWith('nostrconnect://')) return null;
  if (/[#\s]/.test(uri)) return null;
  for (const ch of uri) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return null;
  }
  if (!android) return uri;
  const connection = uri.slice('nostrconnect:'.length);
  return `intent:${connection}#Intent;scheme=nostrconnect;package=${PRIMAL_ANDROID_PACKAGE};end`;
}
