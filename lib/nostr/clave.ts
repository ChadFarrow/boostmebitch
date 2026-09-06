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
// NO TRAILING SLASH, and it is not cosmetic. `createNostrConnectURI` writes
// this string into the URI VERBATIM (URLSearchParams encodes it, it does not
// normalize it), so this is the exact bytes Clave's proxy reads when deciding
// whether the pairing is one it should watch. `wss://relay.powr.build/` is what
// this held while the flow was slow; Conduit — whose iOS Clave flow is the one
// that works — ship `wss://relay.powr.build`. Match the working value rather
// than assume a parser tolerates the difference. (nostr-tools' own
// `normalizeURL` strips it before opening a socket, so OUR pool never cared;
// the signer's side is the one that reads the URI.)
export const CLAVE_RELAY = 'wss://relay.powr.build';

// A SECOND reason it earns its place, and this one is about iOS rather than
// Clave. WebKit bug 302561: on affected iOS builds, iCloud Private Relay can
// allow only the FIRST WebSocket to a given host and port — recorded by Conduit
// (github.com/Conduit-BTC) in their mobile-Safari QA baseline. The bunker runs
// on its OWN SimplePool, separate from the app-wide pool by design, so any
// nostrconnect relay that shares a host with DEFAULT_RELAYS opens the SECOND
// socket to that host and may never connect. NOSTRCONNECT_RELAYS used to carry
// three of them — damus, primal, nos.lol — and that is why they are gone: they
// were reachable by the signer and not by this page, which reads as a pairing
// that is merely slow. relay.nsec.app and this one are the two nothing else in
// the app connects to, which is what makes them the pair the handshake can rely
// on. Do not add a relay here that DEFAULT_RELAYS already holds; the overlap is
// the hazard, and the redundancy it looks like is imaginary.
//
// A SECOND SOCKET IS SPENT BY AN ABANDONED LISTENER TOO, which is the same
// limit reached from the other direction: a pairing attempt the page replaces
// on its way back from the signer keeps its pool until the 120 s window closes,
// so its sockets are still holding the slot the replacement needs. That is what
// `NostrConnectAttempt.abandon` in ./bunker.ts is for.


/**
 * Clave's Universal Link — THE PRIMARY WAY IN, and it works only as a real
 * `<a href>`. The launcher has been reversed three times; this is the shape
 * that both halves of the evidence agree on.
 *
 * **A UNIVERSAL LINK ONLY OPENS THE APP FROM A GENUINE TAP ON A REAL ANCHOR.**
 * iOS does not hand a *programmatic* navigation to an app: a scripted
 * `location.href = …`, or a synthesised `a.click()`, is treated as an ordinary
 * https navigation and the web page loads. Apple documents this, and it holds
 * in SAFARI too — it is not a third-party-browser quirk. Measured here the hard
 * way: dispatched through `openAppLink`, this link navigated the tab to
 * clave.casa, the user paired from that page, and Clave ended up listing
 * BoostMeBitch as connected while the document holding the subscription the ack
 * was addressed to had already died. kind:24133 is ephemeral, so that ack was
 * unrecoverable.
 *
 * The conclusion drawn from that was too broad. The right one is narrower: the
 * URL is only half the mechanism, and the other half is HOW IT IS DISPATCHED.
 * Conduit (github.com/Conduit-BTC, `packages/ui/src/components`) ship this exact
 * URL and it opens the app on the first tap on a physical iPhone — because
 * their `<ClaveConnectButton>` is an `<a href>`, fed by a pairing their
 * `useSignerPairing` hook prepares on mount. A user compared the two flows side
 * by side and reported theirs simply working, which is what moved this back.
 *
 * So it is dispatched from an anchor and **never passed to `openAppLink`**,
 * which cannot work and fails by silently navigating rather than by doing
 * nothing. Preferred over the scheme because it opens the app with no "Open in
 * Clave?" sheet, and because when the app is absent it lands on an install page
 * instead of a silence nothing can report.
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
 * Clave's custom scheme — THE ESCAPE HATCH, and it is the escape precisely
 * because the primary is a Universal Link.
 *
 * A Universal Link can be switched off by the user without their realising it:
 * one tap on the "clave.casa" breadcrumb in Safari's top-right and iOS opens
 * the web page for that domain from then on, permanently, with no UI to undo it
 * and **nothing on the page able to detect it**. The custom scheme is
 * unaffected, which makes it the only cure for the one failure the primary
 * cannot report.
 *
 * Unlike a Universal Link it DOES work from a scripted `a.click()`, so this one
 * goes through `openAppLink`. Two costs keep it second: Safari shows an "Open
 * in Clave?" confirmation sheet, and its own failure mode is silence — an
 * unregistered scheme does nothing observable, which is what the sign-in
 * modal's timed hint is for.
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
