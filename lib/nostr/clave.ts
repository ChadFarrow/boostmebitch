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

// A SECOND reason it earns its place, and this one is about iOS rather than
// Clave. WebKit bug 302561: on affected iOS builds, iCloud Private Relay can
// allow only the FIRST WebSocket to a given host and port — recorded by Conduit
// (github.com/Conduit-BTC) in their mobile-Safari QA baseline. The bunker runs
// on its OWN SimplePool, separate from the app-wide pool by design, and three of
// the five relays in NOSTRCONNECT_RELAYS share a host with DEFAULT_RELAYS
// (damus, primal, nos.lol) — so on such a device those three sockets are the
// second to their host and may never open. relay.nsec.app and this one are the
// two nothing else in the app connects to, which makes them the pair the
// handshake can actually rely on. Do not "tidy" the nostrconnect set down to
// the app's default relays; that overlap is the hazard, not the redundancy.


/**
 * THE PRIMARY WAY IN: Clave's Universal Link.
 *
 * Both this and `claveOpenLink` below hand the app the same pairing URI; the
 * difference is what iOS does with them, and it is not a wash.
 *
 * A Universal Link is Apple's own mechanism. iOS resolves it against the
 * app's cached `apple-app-site-association` and opens Clave directly — no
 * "Open in Clave?" confirmation sheet, which a custom scheme does show, and no
 * silent nothing when the app is absent. **Conduit** (github.com/Conduit-BTC,
 * `conduit-mono`) ships this form and verifies on a physical iPhone that the
 * app launches on the first tap with no intermediate QR or tab step; that is a
 * measurement, which is more than this repo has for the custom scheme.
 *
 * ITS FAILURE MODE IS A NAVIGATION, and that is the honest cost. With Clave not
 * installed the tab goes to clave.casa's install page instead of doing nothing,
 * so this page — and the subscription waiting on the pairing — is gone. That is
 * acceptable *because* of when it happens: with no signer installed there is
 * nobody to approve the pairing, so nothing of value was lost.
 *
 * THE PRIVACY OBJECTION IS REAL BUT SMALLER THAN IT LOOKS, and this file used
 * to overstate it. Yes, the URI carries the ephemeral client pubkey and the
 * connect secret. But when Clave IS installed iOS routes the link from the
 * cached association without fetching anything, so nothing leaves the device on
 * the path that matters; the URI reaches clave.casa's logs only in the case
 * where it is already worthless. The secret proves a pairing, not a key — it
 * cannot sign — and it expires with `NOSTRCONNECT_TIMEOUT_MS`.
 */
export function claveUniversalLink(uri: string): string {
  return `https://clave.casa/connect/?uri=${encodeURIComponent(uri)}`;
}

/**
 * THE PRIMARY WAY IN: Clave's custom scheme.
 *
 * It wins for one property the Universal Link cannot offer outside Safari: it
 * **never navigates this tab**. The page, its module state and the subscription
 * the signer's ack is addressed to all survive the app switch, which is the
 * whole game — a pairing whose ack lands on a destroyed subscription is one the
 * signer thinks succeeded and the page has no way to learn about.
 *
 * It works in every iOS browser, Safari and `WKWebView` alike, PROVIDED a user
 * gesture is behind it. Without one iOS refuses the navigation and Brave
 * reports *"Cannot Open Page … invalid address"* — measured, and the reason
 * `onClaveConnect` takes a `launch` flag that only tap handlers may set.
 *
 * Its own failure mode is silence: an unregistered scheme does nothing
 * observable, which is what the sign-in modal's timed hint and the Universal
 * Link above are for.
 *
 * The shape is Clave's, verified against its reference web client
 * (DocNR/clave-casa, `src/lib/connect-inbound.ts` and the unit tests beside
 * it), not invented here. `encodeURIComponent` is required and not cosmetic:
 * the nostrconnect URI carries its own `?relay=…&secret=…` query, so an
 * unencoded value would be parsed as parameters of the `clave://` URL and the
 * pairing would arrive truncated at the first `?`.
 *
 * THIS IS A HANDOFF, NOT A SIGNING CHANNEL — and so is the link above. There is
 * no callback URL, no return scheme and no pasteboard answer; nothing comes
 * back this way. The user app-switches ONCE, at pairing, and every later
 * signature is a kind:24133 relay message. That is why Clave needs none of the
 * machinery `lib/nostr/amber.ts` carries for Android.
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
