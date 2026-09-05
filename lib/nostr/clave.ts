// Clave — the iOS NIP-46 signer — and the one string a web client needs to
// reach it. https://github.com/DocNR/clave
//
// WHAT CLAVE IS, because the name collides. This is DocNR's iOS *Nostr signer*
// (App Store id below), which keeps the key in the iPhone Keychain and signs in
// the background: a Notification Service Extension is woken by APNs, so the app
// need not be open. It is unrelated to getclave.io, an EVM smart wallet with
// the same name.
//
// IT SPEAKS NIP-46 AND NOTHING ELSE. No NIP-55 intent surface, no iOS
// URL-scheme signing round trip, no in-app browser injecting `window.nostr`.
// NIP-55 is titled "Android Signer Application" and has no iOS section; there
// is no iOS signer NIP to build against. So Clave is a bunker like any other —
// `storage.signer` stays `'bunker'`, `lib/nostr/bunker.ts` carries the
// transport, and `unattendedDecryptOk()` already answers `false` for it.
//
// Which leaves exactly one Clave-specific thing to hold: the URL that hands the
// app a pairing URI in one tap. Everything after that tap is relay traffic.
//
// NO IMPORTS, and keep it that way — this is the leaf `lib/nostr/index.ts` and
// the sign-in modal both read, and a leaf with no imports is one that can be
// loaded by a plain-Node script if this ever grows something worth pinning.

/** App Store id for "Clave - Nostr Signer". */
export const CLAVE_APP_STORE_ID = '6762104155';

/**
 * Where to send someone who taps the button without the app installed.
 *
 * A custom URL scheme SILENTLY NO-OPS on iOS when nothing claims it: no error,
 * no navigation, nothing for the page to observe. So the not-installed case
 * cannot be detected, only offered for — which is why this link is rendered
 * unconditionally next to the button rather than after a failure. Do not add
 * install-detection: the usual timer race (did we lose visibility within N ms?)
 * reports "not installed" for any slow app switch, which is the common case on
 * a cold launch of a signer that has to be woken.
 */
export const CLAVE_APP_STORE_URL = `https://apps.apple.com/app/id${CLAVE_APP_STORE_ID}`;

/**
 * Clave's own relay, which belongs in the `nostrconnect://` URI.
 *
 * It is a persistent proxy Clave keeps a subscription on, and it is what
 * triggers the APNs wake that lets the signer answer while closed. Clave's
 * `docs/nip46-compatibility.md` also states that a client without
 * `switch_relays` — nostr-tools ~2.17, and we pin exactly 2.19.4 — "cannot
 * successfully complete nostrconnect pairing unless the URI already embeds
 * wss://relay.powr.build". So for this app it is not a redundancy relay, it is
 * the one that makes pairing work at all.
 */
export const CLAVE_RELAY = 'wss://relay.powr.build/';

/**
 * Hand a `nostrconnect://` URI to the installed app.
 *
 * The shape is Clave's, verified against its reference web client
 * (DocNR/clave-casa, `src/lib/connect-inbound.ts` and the unit tests beside
 * it), not invented here. `encodeURIComponent` is required and not cosmetic:
 * the nostrconnect URI carries its own `?relay=…&secret=…` query, so an
 * unencoded value would be parsed as parameters of the `clave://` URL and the
 * pairing would arrive truncated at the first `?`.
 *
 * THIS IS A HANDOFF, NOT A SIGNING CHANNEL. There is no callback URL, no return
 * scheme and no pasteboard answer — nothing comes back this way. The user
 * app-switches ONCE, at pairing; every later signature is a kind:24133 relay
 * message. That is the whole reason Clave needs none of the machinery
 * `lib/nostr/amber.ts` carries for Android.
 *
 * DELIBERATELY NOT the universal link. Clave also publishes
 * `https://clave.casa/connect/?uri=…` for the not-installed case, and it is
 * tempting because it degrades to a web page. It also ships the client pubkey
 * and the connect secret to a third-party origin, where they land in an access
 * log. `clave://` keeps the pairing on the device; the App Store link above
 * covers the case it is reaching for.
 */
export function claveOpenLink(uri: string): string {
  return `clave://connect?uri=${encodeURIComponent(uri)}`;
}

/** Open Clave without handing it a pairing URI — for the `bunker://` fallback,
 *  where the user goes to the app to COPY a URI and brings it back here. */
export const CLAVE_OPEN_URL = 'clave://';

// Which pairing URI has already been handed to the Clave app this session.
//
// IT IS MODULE STATE RATHER THAN A REF BECAUSE TWO COMPONENTS LAUNCH CLAVE. The
// header row starts the handshake inside its own click — the only moment Safari
// will let an app-scheme navigation through — and the sign-in modal then mounts
// and picks the same pairing up. `startNostrConnect` memoizes ONE URI per
// session, so both see the same string; without a shared record the modal would
// treat it as new and fire a second navigation at an app the user is already
// standing in.
//
// Cleared by `clearPendingBunkerAttempts` in bunker.ts, alongside the memo it
// shadows, so the two can never disagree about which pairing is live.
let handedToClave: string | null = null;

/**
 * Claim the right to open Clave for this URI. True exactly once per URI.
 *
 * The caller that gets `true` performs the navigation; every later caller —
 * the modal mounting behind the header row, or a visibility retry after the
 * user comes back — gets `false` and re-subscribes instead. That distinction is
 * the whole point: a retry must not send someone back to an app they have
 * already approved in.
 */
export function claimClaveHandoff(uri: string): boolean {
  if (handedToClave === uri) return false;
  handedToClave = uri;
  return true;
}

/** Forget the claim, so the next attempt launches again. Called when the
 *  pairing memo is dropped, and by the "Open Clave again" control — the one
 *  case where re-launching IS the point, because the ack was lost and the user
 *  never got to approve. */
export function clearClaveHandoff(): void {
  handedToClave = null;
}
