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
 * Clave's Universal Link — the SECOND way in, and it must be rendered as a real
 * anchor. It was the primary for one commit; a field report moved it back.
 *
 * **A UNIVERSAL LINK ONLY OPENS THE APP FROM A GENUINE TAP ON A REAL ANCHOR.**
 * iOS does not hand a *programmatic* navigation to an app: a scripted
 * `location.href = …`, or the synthesised `a.click()` inside
 * `lib/app-link.ts`, is treated as an ordinary https navigation and the web
 * page loads. Apple documents this, and it holds in SAFARI too — it is not a
 * third-party-browser quirk.
 *
 * That is exactly what broke it, measured in Safari on an iPhone: dispatched
 * through `openAppLink`, this link navigated the tab to clave.casa. The user
 * paired from that page, so Clave listed BoostMeBitch as a connected client
 * with Full permission — while the original document, its module state and the
 * subscription the ack was addressed to had all died with the navigation.
 * kind:24133 is ephemeral, so that ack was unrecoverable.
 *
 * Conduit (github.com/Conduit-BTC) verify this form opening the app on the
 * first tap on a physical iPhone, and there is no contradiction with the above:
 * their control IS an `<a href>` the user taps. Ours was a scripted click —
 * a different thing wearing the same URL.
 *
 * So: **never pass this to `openAppLink`.** It cannot work, and it fails by
 * silently navigating rather than by doing nothing. Reach it only from an
 * anchor in the DOM, which is what the sign-in modal's clave.casa control is.
 * Rendered that way it serves both silences a custom scheme can produce — the
 * app is missing, or this browser will not dispatch the scheme — because
 * clave.casa opens the app when it can and shows an install page when it
 * cannot.
 *
 * THE PRIVACY NOTE, kept because it is still the right size: the URI carries
 * the ephemeral client pubkey and the connect secret. Where iOS routes the link
 * from the cached association nothing is fetched at all; otherwise it reaches
 * clave.casa, which is Clave's own origin and the party the pairing is with.
 * The secret proves a pairing, not a key — it cannot sign — and it dies with
 * the TTL.
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
 * Unlike a Universal Link it DOES work from a scripted `a.click()`, which is
 * what lets one code path serve the header row — which has to build the URI
 * inside its own click — and the modal button alike. It still needs a user
 * gesture in the call stack: without one iOS refuses the navigation and Brave
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
