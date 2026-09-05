'use client';

import { useEffect, useRef, useState } from 'react';
import { ModalShell } from '../modal-shell';
import dynamic from 'next/dynamic';
// Lazy-loaded: <SignInModal> is imported by the header-mounted <NostrAuth> on
// every page, but the QR only renders on the "Remote Signer → Generate QR" tab.
// Dynamic import keeps qrcode.react out of the initial bundle.
const QRCodeSVG = dynamic(() => import('qrcode.react').then((m) => m.QRCodeSVG), { ssr: false });
import {
  loginWithExtension,
  loginWithAmber,
  loginWithBunker,
  loginWithNostrConnect,
  clearPendingBunkerAttempts,
  isLikelyAndroid,
  isLikelyIOS,
  claveOpenLink,
  claveUniversalLink,
  looksLikeBunkerInput,
  nostrConnectUri,
  hasPendingNostrConnect,
  CLAVE_APP_STORE_URL,
  type NostrIdentity,
} from '@/lib/nostr';
import { openAppLink } from '@/lib/app-link';
import { getLatestPendingAmber, submitManualAmberResult } from '@/lib/nostr/amber';
import { isGoogleAuthConfigured, preloadGis } from '@/lib/nostr/google-auth';
import { useApp } from '@/lib/store';
import { getErrorMessage } from '@/lib/util';
import { AmberCompletion } from './login-methods';
import { GoogleAuthPanel } from './google-auth-panel';

type Tab = 'extension' | 'remote';

// How long a Clave tap sits with no return signal before the box says the app
// may not be installed. Long enough to cover a cold launch of a signer that has
// to be woken; short enough to beat the user's own patience. It is a hint on a
// timer, never a detection — see lib/app-link.ts.
const CLAVE_SLOW_MS = 6_000;

// The same hint, re-armed once the user has come BACK from Clave, where it
// answers a different question — see `claveReturned`. Longer than the six
// seconds above because the wait it covers is real work rather than a silence:
// the ack has to land and `get_public_key` has to answer, and offering an
// escape hatch over the top of a handshake that is about to finish is its own
// kind of noise.
const CLAVE_RETURN_STALL_MS = 12_000;

// Did the relay handshake drop, rather than fail for a reason worth quoting?
//
// CASE-INSENSITIVE: nostr-tools throws "Subscription closed before connection
// was established." with a capital S, so the four `.includes('subscription
// closed')` tests these replace never matched and every one of these boxes
// showed the raw library sentence instead of copy telling the user what to do.
function connectionDropped(msg: string): boolean {
  return /timed out|subscription closed/i.test(msg);
}



// Single sign-in surface: one "Sign in with Nostr" button opens this modal,
// which exposes both a Browser Extension tab and a Remote Signer tab (paste
// bunker:// URI or generate a nostrconnect:// QR). Mirrors the two-tab
// layout other Nostr clients use so desktop users keep both options without
// the old standalone "use a remote signer" link. Amber (Android local
// signer) lives under Remote Signer.
//
// The login functions install whichever window.nostr polyfill they need and
// persist the session; this component just reports the resolved identity via
// onSuccess so the parent runs its usual completeSignIn (Spark disconnect on
// identity switch, profile hydration).
export function SignInModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (id: NostrIdentity, kind: 'extension' | 'amber' | 'bunker' | 'local') => void;
}) {
  const [hasExt] = useState(() => typeof window !== 'undefined' && !!window.nostr);
  const [android] = useState(() => isLikelyAndroid());
  // Lazy initializer, like `android` above: this is read once, on the client,
  // and the deferral is what keeps `navigator` off the server render.
  const [ios] = useState(() => isLikelyIOS());
  // Google onboarding is a SEPARATE path, not a Nostr sign-in method: it mints
  // a key for someone who has none. So it is reachable ONLY by opening this
  // modal with signInIntent === 'google' (the header dropdown lists it as a
  // peer of "Sign in with Nostr"); the Nostr entry point never shows it. When
  // it's open it owns the whole modal — no tab strip, no extension/bunker
  // options — and backing out closes the modal rather than dropping the user
  // into the signer tabs they didn't ask for.
  //
  // Read once via the lazy initializer: this is the view the modal OPENED on,
  // and subscribing would let a late store write yank the user out mid-PIN.
  const [googleConfigured] = useState(() => isGoogleAuthConfigured());
  const [googleOpen] = useState(
    () => googleConfigured && useApp.getState().signInIntent === 'google',
  );
  // WHICH VIEW THIS OPENS ON IS A CORRECTNESS QUESTION, not a preference.
  //
  // `hasExt` answers it for a phone on its own: an iPhone has no extension, so
  // the Remote Signer tab is already the default and the Clave box is the first
  // thing in it. That is why there is no longer a "Sign in with Clave" row in
  // the header menu, and no `signInIntent` for it — the row existed to open
  // this modal on the tab it was going to open on anyway.
  //
  // `hasPendingNostrConnect()` is the case `hasExt` cannot answer: a pairing
  // this tab LOST (a navigation, a reload) is resumed by an effect below
  // whatever tab is showing, so the tab showing has to be the one that can
  // report it. EVERY return-from-the-signer effect bails on `tab !== 'remote'`,
  // so on the wrong tab the ack that lands on the way back from the signer has
  // nothing listening for it and the handshake never completes. Opening on the
  // wrong tab is not cosmetic; it is the handshake failing where nobody can see
  // it.
  const [tab, setTab] = useState<Tab>(() => {
    if (hasPendingNostrConnect()) return 'remote';
    return hasExt ? 'extension' : 'remote';
  });

  // Browser-extension flow.
  const [extBusy, setExtBusy] = useState(false);
  const [extErr, setExtErr] = useState<string | null>(null);
  // Amber flow, NIP-55 (`nostrsigner:` / `intent:` URL, result by callback).
  const [amberBusy, setAmberBusy] = useState(false);
  const [amberErr, setAmberErr] = useState<string | null>(null);
  // Amber flow, NIP-46: a `nostrconnect://` link opened IN Amber, the session
  // then runs over a relay like any bunker. This is the primary Android path
  // and it is how StableKraft's "Amber (Android)" button has always worked.
  // Nothing comes back by URL: no callback tab, no clipboard, no page reload,
  // and Amber routes a `nostrconnect:` intent BEFORE the browser-id check that
  // broke bare `nostrsigner:` URLs in 2026-08 (docs/signers.md). The installed
  // Amber (the `free` flavor on Zapstore and F-Droid) registers the scheme as
  // BROWSABLE; the `offline` flavor does not, which is what the NIP-55 button
  // below is still for.
  const [amberNcBusy, setAmberNcBusy] = useState(false);
  const [amberNcErr, setAmberNcErr] = useState<string | null>(null);
  // The URI this modal already handed to Amber. The memo inside
  // loginWithNostrConnect returns the same URI on a retry, and Amber already
  // holds that pairing, so the link is opened ONCE per URI — a retry after
  // the user comes back must re-subscribe, not re-launch Amber.
  const amberNcOpened = useRef<string | null>(null);
  // `startNostrConnect` memoizes the URI and the client key, but builds a FRESH
  // `ready` (a new relay subscription) on every call — so the visibility-driven
  // retry below runs alongside the click-driven attempt rather than replacing
  // it. Without this, two acks would call finalizeBunkerLogin twice (two live
  // transports, onSuccess/onClose on an unmounted modal), and the older
  // attempt's 120 s timeout would write "Connection dropped" over a session
  // that is still coming up. Only the newest attempt may report anything.
  const amberNcAttempt = useRef(0);
  const amberNcSettled = useRef(false);
  // Clave flow (iOS). NIP-46 over a `nostrconnect://` URI handed to the app by
  // its own `clave://connect?uri=` scheme — the same shape as the Android Amber
  // button above, and for the same reason: on the phone that is displaying it,
  // a QR code is not an option.
  //
  // Clave speaks NIP-46 and nothing else, so there is no NIP-55-style peer in
  // this box to fall back to. Its fallback is Option 2 below, which is what
  // Clave's own docs recommend for same-device iOS pairing.
  const [claveBusy, setClaveBusy] = useState(false);
  const [claveErr, setClaveErr] = useState<string | null>(null);
  // Its OWN auth-url slot rather than reusing `genAuthUrl`. The Amber branch
  // reuses it, which renders the "Approve in signer" box inside Option 1 —
  // several hundred pixels below the button the user actually pressed. Do not
  // copy that into a second branch.
  const [claveAuthUrl, setClaveAuthUrl] = useState<string | null>(null);
  // Drives the "nothing happened?" hint. It is the ONLY signal available for a
  // missing app: see lib/app-link.ts.
  const [claveSlow, setClaveSlow] = useState(false);
  // The live pairing URI, in STATE, because it is now an `href`. The ref below
  // keeps the same value for the synchronous reads inside prepareClave.
  const [claveUri, setClaveUri] = useState<string | null>(null);
  // "The user has gone to Clave at least once." NOT the same thing as
  // `claveBusy`, which is true from the moment this box opens — the pairing is
  // prepared before the user touches anything, so busy cannot mean "waiting for
  // them". Only this may say "approve in Clave, then come back", and only this
  // may arm the nothing-happened timer.
  const [claveSent, setClaveSent] = useState(false);
  // The same fact, readable from inside prepareClave's closure. See its catch.
  const claveSentRef = useRef(false);
  // "AND THEY HAVE COME BACK." The third state in a sequence the box used to
  // collapse into two, which is why coming back from Clave looked like nothing
  // had happened: the button still read "Open Clave again", the sentence still
  // said "then come back here", and the only thing that DID change was the
  // six-second hint firing — so the one new thing on screen said the app might
  // not be installed, about an app the user had just been standing in.
  //
  // It also settles what the hint means. Before a return, a silence is "nothing
  // opened". After one, the app demonstrably opened and the same silence is
  // "the ack has not landed yet", which needs different words and no App Store
  // link. One flag, `claveSlow`, still carries the silence; this one says which
  // silence it is.
  const [claveReturned, setClaveReturned] = useState(false);
  // The clipboard route into Option 2 — see onPasteFromClipboard.
  const [clipErr, setClipErr] = useState<string | null>(null);
  const claveSlowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Only the newest attempt may report — same role as amberNcAttempt above.
  //
  // There is no `claveOpened` ref beside it, and that asymmetry with the Amber
  // box is deliberate: the "have we already handed this URI to the app" record
  // lives in lib/nostr/clave.ts, because the HEADER row can launch Clave before
  // this modal exists. A ref here would start life null in that case and fire a
  // second navigation at an app the user is already standing in.
  const claveAttempt = useRef(0);
  // The pairing URI this modal last handed over, so the custom-scheme retry
  // below can re-launch the SAME one. Not derived from a fresh
  // `loginWithNostrConnect()` call, which would open another subscription.
  const claveUriRef = useRef<string | null>(null);
  // "Has ANY attempt signed in yet", which is not the same question as "is this
  // the newest attempt" — see the success path below.
  const claveSettled = useRef(false);
  // THE ONE LIVE LISTENER ON THIS PAGE'S PAIRING. See startPairing below.
  const liveAttempt = useRef<{ abandon: () => void } | null>(null);
  // Paste bunker:// flow.
  const [pasteValue, setPasteValue] = useState('');
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteErr, setPasteErr] = useState<string | null>(null);
  const [pasteAuthUrl, setPasteAuthUrl] = useState<string | null>(null);
  // Generate nostrconnect:// flow.
  const [genUri, setGenUri] = useState<string | null>(null);
  const [genBusy, setGenBusy] = useState(false);
  const [genErr, setGenErr] = useState<string | null>(null);
  const [genAuthUrl, setGenAuthUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Fetch the GIS script the moment the modal is on screen rather than when the
  // user taps "Continue with Google" — a cold fetch inside the click path burns
  // its transient activation and the consent popup gets blocked. See
  // preloadGis().
  useEffect(() => {
    if (googleOpen) preloadGis();
  }, [googleOpen]);


  async function onExtension() {
    setExtBusy(true);
    setExtErr(null);
    try {
      const id = await loginWithExtension();
      onSuccess(id, 'extension');
      onClose();
    } catch (e) {
      setExtErr(getErrorMessage(e, 'extension sign-in failed'));
    } finally {
      setExtBusy(false);
    }
  }

  function submitManualPaste(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (!getLatestPendingAmber()) {
      setAmberErr('No pending Amber request to attach this to.');
      return false;
    }
    return submitManualAmberResult(trimmed);
  }

  /**
   * Open a listener on the session's pairing, closing the one it replaces.
   *
   * ONE PAIRING, MANY LISTENERS, ONE LIVE AT A TIME. All three boxes in this
   * modal — Clave, Amber, the QR — call `loginWithNostrConnect`, which returns
   * the SAME memoized URI and client key every time and a FRESH subscription
   * each time. Every one of the three also re-subscribes when the tab comes
   * back from the signer app, which is the right thing to do (the socket the
   * page left with may be dead) and the wrong thing to do additively: the
   * abandoned listener kept its own SimplePool alive for the rest of the 120 s
   * pairing window, so every app switch stacked another set of sockets.
   *
   * That is not merely untidy on the device this flow is for. `lib/nostr/clave.ts`
   * records the measurement: on affected iOS builds iCloud Private Relay allows
   * only the FIRST WebSocket to a given host and port, so the replacement
   * listener's sockets can be the second to their host and never open — the ack
   * then has nowhere to land, and the flow presents as "slow", then works.
   *
   * The URI, client key and secret are untouched by the swap. That is what lets
   * the signer recognise an already-approved client and re-ack without asking
   * the user a second time. Conduit
   * (Conduit-BTC/conduit-mono, packages/core/src/protocol/remote-signer.ts) run
   * the same rule as a loop rather than a ref — "superseded listeners and their
   * sockets close before replacement" — and their tests assert the URI and the
   * key are unchanged across a foreground return.
   */
  function startPairing(onAuthUrl: (url: string) => void) {
    liveAttempt.current?.abandon();
    const attempt = loginWithNostrConnect(onAuthUrl);
    liveAttempt.current = attempt;
    return attempt;
  }

  // Same `launch` rule as onClaveConnect, and it is the SAME defect rather than
  // a precaution copied across: `amberNcOpened` is keyed on the URI, and
  // startNostrConnect clears its memo on success, so a visibility retry that
  // raced that success got a fresh URI, sailed past the guard and dispatched an
  // intent with no user activation — for a pairing Amber has never seen. The
  // iPhone report that found this is in onClaveConnect's header; nothing about
  // it is iOS-specific.
  async function onAmberConnect({ launch = true }: { launch?: boolean } = {}) {
    if (!launch && amberNcOpened.current && nostrConnectUri() !== amberNcOpened.current) {
      setAmberNcBusy(false);
      setAmberNcErr('That pairing is no longer live. Tap Sign in with Amber to start a new one.');
      return;
    }
    const attempt = ++amberNcAttempt.current;
    const isCurrent = () => amberNcAttempt.current === attempt;
    setAmberNcBusy(true);
    setAmberNcErr(null);
    try {
      const { uri, ready } = startPairing((url) => setGenAuthUrl(url));
      if (launch && amberNcOpened.current !== uri) {
        amberNcOpened.current = uri;
        openAppLink(uri);
      }
      const id = await ready;
      // Same rule as onClaveConnect: a success from ANY attempt signs in, and
      // the latch — not the newest-attempt check — is what stops two acks
      // signing in twice. Gating success on isCurrent() discarded the approval
      // the user had just given, because the visibility retry bumps the counter
      // at precisely the moment the original attempt resolves.
      if (amberNcSettled.current) return;
      amberNcSettled.current = true;
      onSuccess(id, 'bunker');
      onClose();
    } catch (e) {
      if (!isCurrent() || amberNcSettled.current) return;
      setAmberNcErr(getErrorMessage(e, 'Amber connection failed'));
    } finally {
      if (isCurrent()) setAmberNcBusy(false);
    }
  }

  async function onAmber() {
    setAmberBusy(true);
    setAmberErr(null);
    try {
      const id = await loginWithAmber();
      onSuccess(id, 'amber');
      onClose();
    } catch (e) {
      setAmberErr(getErrorMessage(e, 'Amber sign-in failed'));
    } finally {
      setAmberBusy(false);
    }
  }

  /**
   * SUBSCRIBE TO THE PAIRING. IT NEVER NAVIGATES ANYWHERE — that is the whole
   * shape of this flow now, and the `launch` flag this used to carry is gone.
   *
   * Reaching Clave is an `<a href>` the user taps (`<ClaveConnectLink>` below).
   * A Universal Link only opens an app from a genuine tap on a real anchor, so
   * there is nothing left for JavaScript to dispatch: this function's whole job
   * is to have a live subscription waiting before that tap happens, and to get
   * one back when the user returns.
   *
   * It is called from three places, none of which is a navigation: the
   * prepare-on-open effect, the anchor's own click (so the subscription is
   * refreshed in the same gesture that leaves for the app), and the
   * visibility retry on the way back.
   */
  async function prepareClave() {
    // Read the live pairing WITHOUT subscribing — that is what nostrConnectUri
    // is for. A retry whose pairing has been replaced must stop here, before it
    // opens a transport nothing will ever answer.
    if (claveUriRef.current && nostrConnectUri() !== claveUriRef.current) {
      setClaveBusy(false);
      setClaveErr('That pairing is no longer live. Close this and start again.');
      return;
    }
    const attempt = ++claveAttempt.current;
    const isCurrent = () => claveAttempt.current === attempt;
    setClaveBusy(true);
    setClaveErr(null);
    try {
      const { uri, ready } = startPairing((url) => setClaveAuthUrl(url));
      // BOTH a ref and a state, and they answer different questions. The ref is
      // read synchronously inside this function on the next attempt; the state
      // is what puts a live URI into the anchor's href. Neither can do the
      // other's job: a ref never re-renders, and a state read inside this
      // closure would be the one from the render this attempt started in.
      claveUriRef.current = uri;
      setClaveUri(uri);
      const id = await ready;
      // A SUCCESS FROM ANY ATTEMPT COUNTS, and this deliberately does not ask
      // isCurrent(). The newest-attempt rule is right for reporting an error —
      // an older attempt's timeout must not overwrite a live one — but applied
      // to success it throws away the very thing the user did: the visibility
      // retry bumps the counter on the way back from the signer, which is
      // exactly when the original attempt is resolving with the approval. That
      // made "approve in Clave, switch back" sign in nowhere at all.
      //
      // The latch still keeps two acks from signing in twice, which is all
      // isCurrent() was buying here.
      if (claveSettled.current) return;
      claveSettled.current = true;
      onSuccess(id, 'bunker');
      onClose();
    } catch (e) {
      if (!isCurrent() || claveSettled.current) return;
      // A PREPARE THE USER NEVER ACTED ON MAY NOT REPORT A FAILURE. The pairing
      // is subscribed when the box opens, so this attempt can time out 120 s
      // later under someone who has not touched anything — and telling them
      // "no answer yet" about a request they never sent is a lie about the
      // signer. Nothing is lost by staying quiet: the anchor re-prepares on tap
      // whenever no attempt is live, so a stale subscription is repaired at the
      // exact moment it starts to matter.
      if (!claveSentRef.current) return;
      setClaveErr(getErrorMessage(e, 'Clave connection failed'));
    } finally {
      if (isCurrent()) {
        setClaveBusy(false);
        if (claveSlowTimer.current) { clearTimeout(claveSlowTimer.current); claveSlowTimer.current = null; }
      }
    }
  }

  /**
   * Take the `bunker://` URI straight off the clipboard, for ANY signer.
   *
   * It began as a Clave-only control inside the Clave box, on the argument that
   * the vendor's own docs call a pasted `bunker://` the reliable same-device
   * iOS path. That was true and the placement was wrong: the Clave box ended up
   * carrying its own "open the app" and "paste from the app" pair beside a
   * general Option 2 that does the same job for every signer, so the tab
   * offered the same flow twice and the phone box was three controls deep.
   *
   * The convenience was worth keeping, so it moved rather than went: this is
   * Option 2's *Paste* button now, and nsec.app and Amber-in-server-mode get it
   * too. The tedium it removes is not Clave-specific — copy, come back, tap the
   * field, long-press, Paste, tap Connect — and the clipboard read collapses it
   * to one tap plus the browser's own paste confirmation.
   *
   * It must be called FROM A CLICK — `readText()` needs transient activation on
   * every browser that implements it, and iOS Safari additionally renders its
   * own "Paste" button that the user has to press. That system prompt is why
   * this is an explicit control rather than something the visibility listener
   * does on return: a paste sheet appearing unbidden reads as the page
   * misbehaving.
   *
   * `looksLikeBunkerInput` is a shape test, not a parse. Someone whose clipboard
   * still holds a shopping list gets a hint instead of a connect attempt and a
   * parser error about their shopping list.
   */
  async function onPasteFromClipboard() {
    setClipErr(null);
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      // Denied, unsupported, or no activation left. The paste box below still
      // works, so say that rather than describing a permission screen.
      setClipErr('Could not read the clipboard — paste the URI into the field instead.');
      return;
    }
    const trimmed = text.trim();
    if (!looksLikeBunkerInput(trimmed)) {
      setClipErr('That does not look like a bunker:// URI. Copy it in your signer, then tap again.');
      return;
    }
    // Hand it to the existing paste flow rather than a second one, so the field
    // beside this shows what is being connected and one code path owns the
    // errors.
    setPasteValue(trimmed);
    setPasteBusy(true);
    setPasteErr(null);
    setPasteAuthUrl(null);
    try {
      const id = await loginWithBunker(trimmed, (url) => setPasteAuthUrl(url));
      onSuccess(id, 'bunker');
      onClose();
    } catch (e) {
      setPasteErr(getErrorMessage(e, 'bunker connect failed'));
    } finally {
      setPasteBusy(false);
    }
  }

  /**
   * THE PRIMARY CONTROL, AND IT IS AN `<a href>` ON PURPOSE.
   *
   * A Universal Link opens the app only from a genuine tap on a real anchor;
   * dispatched from script it is an ordinary https navigation and clave.casa's
   * web page loads instead. That is not a browser quirk to route around — it is
   * the mechanism — so the control has to BE the anchor rather than a button
   * that builds one.
   *
   * Which is why the pairing is prepared before this renders. An anchor's href
   * has to exist at render time, so there is no "mint the URI inside the click"
   * step left; the effect below does it when the box opens, and this shows a
   * disabled button for the moment in between.
   *
   * Conduit (github.com/Conduit-BTC, `packages/ui/src/components`) ships exactly
   * this — `<ClaveConnectButton>` is an `<a>` around `clave.casa/connect/?uri=`,
   * fed by a pairing their `useSignerPairing` prepares on mount — and it is what
   * a user compared this against: tap, Clave opens, switch back, signed in. Ours
   * asked them to tap a scripted `clave://` instead, which shows an "Open in
   * Clave?" sheet on the way out and could not use the Universal Link at all.
   *
   * `prepareClave()` runs in the same click, but ONLY when nothing is already
   * listening. The anchor is worth no more than the subscription behind it, and
   * an attempt that has already timed out would let the ack arrive with nobody
   * home — but re-subscribing over a live attempt just opens a second socket on
   * one pairing, so `claveBusy` decides.
   */
  function ClaveConnectLink() {
    if (!claveUri) {
      return (
        <button disabled className="btn-bolt w-full disabled:opacity-40">
          Preparing connection…
        </button>
      );
    }
    // WHILE THE HANDSHAKE IS FINISHING THIS IS NOT THE ACTION, so it stops
    // looking like one. It stays a real `<a href>` — that is the mechanism, and
    // a class cannot change it — but a full-width yellow "Open Clave again" as
    // the loudest thing on screen tells someone who has just come back that
    // they still have work to do, at the exact moment they do not. The status
    // line beside it is what matters then. Once the stall hint fires, going
    // back to Clave IS the suggestion again, so the emphasis returns with it.
    const finishing = claveReturned && claveBusy && !claveSlow && !claveErr;
    return (
      <a
        href={claveUniversalLink(claveUri)}
        target="_self"
        rel="noopener"
        onClick={() => { markClaveSent(); if (!claveBusy) void prepareClave(); }}
        className={`${finishing ? 'btn-ghost' : 'btn-bolt'} w-full no-underline`}
      >
        {claveSent ? 'Open Clave again' : 'Sign in with Clave'}
      </a>
    );
  }

  /**
   * The escape hatch, and it is the custom scheme precisely because the primary
   * is not.
   *
   * A Universal Link can be switched off by the user without their realising
   * it: one tap on the "clave.casa" breadcrumb in Safari's top-right and iOS
   * opens the web page for that domain from then on, permanently, with no UI to
   * undo it and nothing on the page able to detect it. `clave://` is unaffected,
   * which makes this the only cure for the one failure the primary cannot
   * report. It is a scripted click, which is fine — a custom scheme, unlike a
   * Universal Link, is dispatched from one.
   */
  function ClaveSchemeButton({ label }: { label: string }) {
    if (!claveUri) return null;
    return (
      <button
        onClick={() => { markClaveSent(); if (!claveBusy) void prepareClave(); openAppLink(claveOpenLink(claveUri)); }}
        className="btn-ghost text-[10px] py-1 px-2"
      >
        {label}
      </button>
    );
  }

  /**
   * Record that the user left for Clave, and start the only clock that can
   * report a silence.
   *
   * It is armed HERE rather than when the pairing is prepared, because the
   * question it answers is "you tapped and nothing opened" — asking it of a
   * pairing the user has not acted on yet would put a "Clave may not be
   * installed" hint under a button nobody has pressed.
   */
  function markClaveSent() {
    claveSentRef.current = true;
    setClaveSent(true);
    // A fresh trip, so we are back to "did anything open?" until they return
    // again. Tapping "Open Clave again" after a stalled handshake has to reset
    // this or the box keeps describing the previous round trip.
    setClaveReturned(false);
    setClaveSlow(false);
    if (claveSlowTimer.current) clearTimeout(claveSlowTimer.current);
    claveSlowTimer.current = setTimeout(() => setClaveSlow(true), CLAVE_SLOW_MS);
  }

  async function onGenerate() {
    setGenBusy(true);
    setGenErr(null);
    setGenAuthUrl(null);
    // Don't clear genUri — loginWithNostrConnect's session memo returns the
    // same URI on retry, so the QR the user already scanned stays valid.
    setCopied(false);
    try {
      const { uri, ready } = startPairing((url) => setGenAuthUrl(url));
      setGenUri(uri);
      const id = await ready;
      onSuccess(id, 'bunker');
      onClose();
    } catch (e) {
      setGenErr(getErrorMessage(e, 'nostrconnect failed'));
    } finally {
      setGenBusy(false);
    }
  }

  async function onPasteSubmit() {
    setPasteBusy(true);
    setPasteErr(null);
    setPasteAuthUrl(null);
    try {
      const id = await loginWithBunker(pasteValue, (url) => setPasteAuthUrl(url));
      onSuccess(id, 'bunker');
      onClose();
    } catch (e) {
      setPasteErr(getErrorMessage(e, 'bunker connect failed'));
    } finally {
      setPasteBusy(false);
    }
  }

  async function copyGenUri() {
    if (!genUri) return;
    try {
      await navigator.clipboard.writeText(genUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* fall through — user can long-press the code block */
    }
  }

  // iOS Safari suspends WebSocket subscriptions the moment the user
  // backgrounds the tab to scan/paste the URI in their signer. On return,
  // re-attempt: the memoized clientSk + URI inside loginWithNostrConnect /
  // loginWithBunker mean the signer recognizes the same pairing and acks
  // immediately on the fresh subscription. Attach whenever the flow is
  // in-flight OR has already failed.
  useEffect(() => {
    if (tab !== 'remote') return;
    if (!genBusy && !genErr) return;
    // THE CLAVE BUTTON AND THIS BOX SHARE ONE PAIRING, which the Android box
    // never had to worry about. Both call loginWithNostrConnect, whose memo
    // returns the SAME URI but builds a FRESH `ready` — so if both effects fire
    // on one return, two subscriptions resolve on one pairing and
    // finalizeBunkerLogin runs twice: two live transports, and onSuccess/onClose
    // on an unmounted modal. `claveAttempt` only guards within its own branch.
    // Reachable in two taps on iOS: tap Sign in with Clave, watch nothing happen
    // because Clave is not installed, tap Generate QR Code.
    if (claveBusy) return;
    if (typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') onGenerate();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, genErr, genBusy, claveBusy]);

  // The Clave half of the same rule, plus the Amber one restated for its own
  // fallback: the documented next moves after a failed Clave handshake are the
  // QR box and the bunker paste in this same tab, and coming back from EITHER of
  // those signer trips is a visibilitychange too. Restarting the handshake on it
  // would disable those controls under the user's own in-flight request.
  useEffect(() => {
    if (tab !== 'remote') return;
    if (!claveBusy && !claveErr) return;
    if (genBusy || pasteBusy) return;
    if (typeof document === 'undefined') return;
    const onVisible = () => {
      // Re-subscribe. Nothing here navigates — see prepareClave's header.
      if (document.visibilityState === 'visible') void prepareClave();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, claveErr, claveBusy, genBusy, pasteBusy]);

  // SAYING SO ON SCREEN IS A SEPARATE JOB FROM RE-SUBSCRIBING, and this is a
  // second listener rather than two lines inside the one above on purpose: that
  // effect bails on `genBusy || pasteBusy` and on there being no live attempt,
  // because restarting a handshake under someone's own in-flight request is
  // wrong. None of those reasons apply to TELLING THE USER WHAT IS HAPPENING —
  // a box that goes quiet exactly when its guards fire is the fault being fixed
  // here, not a case to inherit.
  //
  // Only armed once they have actually left (`claveSent`), so the very first
  // paint of the box cannot claim a return that never happened.
  useEffect(() => {
    if (!ios || tab !== 'remote' || !claveSent) return;
    if (typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      setClaveReturned(true);
      // THE APP OPENED. Whatever the six-second timer was about to claim, it is
      // not true any more, so drop the pending one and the hint it may already
      // have set before re-arming for the longer question. Without this the one
      // thing that changed on returning from Clave was "Clave may not be
      // installed", under a button the user had just used to open it.
      if (claveSlowTimer.current) clearTimeout(claveSlowTimer.current);
      setClaveSlow(false);
      claveSlowTimer.current = setTimeout(() => setClaveSlow(true), CLAVE_RETURN_STALL_MS);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [ios, tab, claveSent]);

  // Same shape for the Amber nostrconnect flow: Android suspends the page's
  // WebSocket while the user is in Amber approving, so the relay ack can land
  // on a dead subscription. Coming back re-subscribes with the memoized URI;
  // `amberNcOpened` keeps it from sending the user to Amber a second time.
  useEffect(() => {
    if (tab !== 'remote') return;
    if (!amberNcBusy && !amberNcErr) return;
    // `amberNcErr` keeps this listener attached after a failed relay attempt,
    // which is wanted — but the documented next move is the NIP-55 fallback in
    // the same box. Coming back from THAT trip is a visibilitychange too, and
    // restarting nostrconnect on it disables the fallback button under the
    // user's own in-flight request and relabels the primary one. A NIP-55
    // request in flight owns the return.
    if (amberBusy) return;
    if (typeof document === 'undefined') return;
    const onVisible = () => {
      // Re-subscribe only — never re-dispatch. See onAmberConnect's header.
      if (document.visibilityState === 'visible') onAmberConnect({ launch: false });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, amberNcErr, amberNcBusy, amberBusy]);

  // Same return-from-the-signer retry as the two above, with one difference
  // that matters: this one re-submits a value the USER can still edit.
  //
  // `onPasteSubmit` reads `pasteValue` from the render the effect last ran in.
  // Without `pasteValue` in the deps, the listener attached after a FAILED
  // attempt kept that render's value forever — the deps stop changing at that
  // point, so typing a corrected URI did not re-run the effect. Pasting a bad
  // URI, fixing it, going to the signer and coming back then reconnected with
  // the OLD one and rewrote the error from it, over a box showing the new one.
  useEffect(() => {
    if (tab !== 'remote') return;
    if (!pasteBusy && !pasteErr) return;
    if (typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') onPasteSubmit();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, pasteErr, pasteBusy, pasteValue]);

  // PREPARE THE PAIRING WHEN THE BOX OPENS, before the user taps anything.
  //
  // This is not an optimisation, it is what makes the primary control possible:
  // it is an `<a href>`, and an anchor's href has to exist at render time. The
  // old shape minted the URI inside the click, which forced a scripted
  // navigation, which a Universal Link cannot be dispatched from — so the whole
  // flow had to fall back to `clave://` and its confirmation sheet.
  //
  // It also resumes A PAIRING THIS TAB LOST. `prepareClave` goes through
  // `loginWithNostrConnect`, whose memo restores `storage.ncPending` when it is
  // still fresh, so a navigation or reload gets its listener back rather than
  // leaving the user on a dead "Sign in" page while the signer believes it is
  // connected.
  //
  // Once per open, hence the ref: the deps carry `tab` so switching INTO the
  // Remote Signer tab prepares it, and toggling tabs afterwards must not open a
  // second subscription on the same pairing.
  const clavePrepared = useRef(false);
  useEffect(() => {
    // `ios` as well as the tab: the box that reports this attempt only renders
    // on iOS, so without it a subscription would be in flight with no screen
    // attached to it — busy state nobody can see or cancel.
    if (!ios) return;
    if (tab !== 'remote') return;
    if (clavePrepared.current) return;
    clavePrepared.current = true;
    void prepareClave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ios, tab]);


  // The "may not be installed" timer is the one thing here that outlives the
  // render if nobody clears it: it fires setState on an unmounted modal after
  // the user gives up and closes.
  useEffect(() => () => {
    if (claveSlowTimer.current) clearTimeout(claveSlowTimer.current);
  }, []);

  function handleClose() {
    // Drop any half-finished paste/generate attempt so a future session
    // starts clean.
    //
    // The listener has to come down WITH the memo, not just after it.
    // `clearPendingBunkerAttempts` forgets the URI and the client key; it does
    // not touch the transport, so closing this modal used to leave a live
    // subscription and its sockets running until the pairing timed out two
    // minutes later — against the per-host socket limit the next attempt needs.
    liveAttempt.current?.abandon();
    liveAttempt.current = null;
    clearPendingBunkerAttempts();
    onClose();
  }

  const tabClass = (active: boolean) =>
    `flex-1 px-4 py-3 text-sm transition ${
      active
        ? 'text-nostr border-b-2 border-nostr -mb-px'
        : 'text-muted hover:text-bone'
    }`;

  return (
    <ModalShell onClose={handleClose} label="Sign in" className="w-full max-w-md">
        {/* The padding IS the tap target — the glyph does not move. It was
            `top-2 right-3` with no padding, i.e. an ~11px-wide box, under WCAG
            2.5.8's 24x24 floor. `px-3 py-2` at `top-0 right-0` puts the x
            exactly where it was (12px in, 8px down) inside a 44x35 button. */}
        <button
          onClick={handleClose}
          className="absolute top-0 right-0 px-3 py-2 text-muted hover:text-bone text-lg z-10"
          aria-label="Close"
        >
          ×
        </button>

        <div className="p-5 border-b border-bone/15">
          {googleOpen ? (
            <>
              <div className="stamp text-bolt border-bolt/60 mb-2">◆ GOOGLE</div>
              <h3 className="font-display text-2xl leading-tight">Continue with Google</h3>
              {/* The wallet clause matches <AuthControl>'s menu subtitle on
                  purpose: this panel is the screen that row opens, so a wallet
                  promised there and unmentioned here reads as a promise
                  withdrawn. Both are conditioned on "new" — only the
                  new-account branch calls provisionSparkFromKey; a returning
                  user restores the wallet they already have. */}
              <p className="text-[11px] text-muted mt-2">
                New to Nostr? This creates a key for you and backs it up to your own
                Google Drive, encrypted with a PIN only you know. You get a Lightning
                wallet with it, ready to boost.
              </p>
            </>
          ) : (
            <>
              <div className="stamp text-nostr border-nostr/60 mb-2">◆ NOSTR</div>
              <h3 className="font-display text-2xl leading-tight">Sign in with Nostr</h3>
            </>
          )}
        </div>

        {googleOpen && (
          <div className="p-5 border-b border-bone/15 flex flex-col gap-2">
            <GoogleAuthPanel
              onSuccess={(id) => {
                onSuccess(id, 'local');
                onClose();
              }}
              onCancel={handleClose}
            />
          </div>
        )}

        {!googleOpen && (
          <>
            <div className="flex border-b border-bone/15">
              <button onClick={() => setTab('extension')} className={tabClass(tab === 'extension')}>
                Browser Extension
              </button>
              <button onClick={() => setTab('remote')} className={tabClass(tab === 'remote')}>
                Remote Signer
              </button>
            </div>

            <div className="p-5 flex flex-col gap-4">
              {tab === 'extension' ? (
                <>
                  <p className="text-xs text-muted">
                    Connect using a NIP-07 browser extension like Alby, nos2x, or
                    Nostr Connect.
                  </p>
                  {!hasExt && (
                    <div className="border border-nostr/40 bg-nostr/10 p-2 text-[11px] text-bone">
                      No Nostr extension detected. Install one to use this method,
                      or use Remote Signer for mobile.
                    </div>
                  )}
                  <button
                    onClick={onExtension}
                    disabled={!hasExt || extBusy}
                    className="btn-bolt w-full disabled:opacity-40"
                  >
                    {extBusy ? 'Connecting…' : 'Connect with Extension'}
                  </button>
                  {extErr && <span className="text-[11px] text-nostr/80">{extErr}</span>}
                </>
              ) : (
                <>
                  {/* Name the signer whose button is directly below this
                      sentence. It used to read "Primal (iOS/Android), Amber
                      (Android)" on every platform, so an iPhone user met a
                      paragraph listing an Android app and not the one they were
                      about to tap. */}
                  <p className="text-xs text-muted">
                    {ios
                      ? 'Connect using a signer app on this phone — Clave or Primal — or any NIP-46 compatible app.'
                      : android
                        ? 'Connect using a signer app on this phone — Amber or Primal — or any NIP-46 compatible app.'
                        : 'Connect using a remote signer like Primal (iOS/Android), Amber (Android), Clave (iOS), or any NIP-46 compatible app.'}
                  </p>

                  {android && (
                    <div className="border border-bone/15 p-3 flex flex-col gap-2">
                      <button
                        onClick={() => onAmberConnect()}
                        disabled={amberNcBusy || amberBusy}
                        className="btn-bolt w-full disabled:opacity-40"
                      >
                        {amberNcBusy ? 'Waiting for Amber…' : 'Sign in with Amber'}
                      </button>
                      {amberNcBusy && (
                        <span className="text-[11px] text-muted">
                          Approve the connection in Amber, then come back here — this
                          page finishes on its own. Nothing to paste.
                        </span>
                      )}
                      {amberNcErr && (
                        <span className="text-[11px] text-nostr/80">
                          {connectionDropped(amberNcErr)
                            ? 'Connection dropped — approve in Amber, then tap Sign in with Amber again.'
                            : amberNcErr}
                        </span>
                      )}
                      {/* NIP-55 stays as the fallback: the `offline` Amber build
                          has no nostrconnect handler, and a relay outage should
                          not lock an Android user out. */}
                      <button
                        onClick={onAmber}
                        disabled={amberBusy || amberNcBusy}
                        className="btn-ghost text-[10px] py-1 px-2 self-start disabled:opacity-40"
                      >
                        {amberBusy ? 'Connecting…' : 'Amber without a relay (nostrsigner link)'}
                      </button>
                      {amberBusy && <AmberCompletion onSubmit={submitManualPaste} />}
                      {amberErr && <span className="text-[11px] text-nostr/80">{amberErr}</span>}
                    </div>
                  )}

                  {/* iOS: hand the pairing URI straight to Clave. Mirrors the
                      Android box above and sits in the same slot; the two are
                      mutually exclusive by UA, so exactly one renders. Above
                      Option 1 for the same reason Amber is: on the phone
                      showing the QR, the QR is not an option. */}
                  {ios && (
                    <div className="border border-bone/15 p-3 flex flex-col gap-2">
                      <ClaveConnectLink />
                      {/* THE BOX HAS TO SAY WHERE IN THE FLOW IT IS, and until
                          now it said the same thing before and after the trip.
                          `claveBusy` was never rendered anywhere — it existed
                          only as a guard — so coming back from Clave changed
                          nothing on screen, and the handshake finished (or did
                          not) in silence. Three states, because the sequence
                          has three: not gone yet, gone, come back. */}
                      {claveReturned && claveBusy ? (
                        <span className="text-[11px] text-nostr animate-bolt">
                          ◆ Finishing sign-in with Clave…
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted">
                          {claveSent
                            ? 'Approve the connection in Clave, then come back here — this page finishes on its own. Nothing to paste.'
                            : 'Your keys stay in Clave. Tapping this opens the app with the connection request already in it.'}
                        </span>
                      )}
                      {claveAuthUrl && (
                        <div className="flex flex-col items-start gap-1 border border-nostr/40 bg-nostr/10 p-2">
                          <span className="text-[10px] text-bone">
                            Clave wants you to approve this connection.
                          </span>
                          <a
                            href={claveAuthUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn-bolt text-[11px] py-1 px-3 no-underline"
                          >
                            ◆ Approve in Clave
                          </a>
                        </div>
                      )}
                      {/* A SILENCE MEANS TWO DIFFERENT THINGS AND THE TIMER
                          CANNOT TELL THEM APART — `claveReturned` can.

                          Before a return: the app may be missing, or Safari may
                          have been told once, by a tap on the clave.casa
                          breadcrumb, to stop routing that domain to the app,
                          which no page can detect. Neither reports itself, so
                          both answers are offered rather than guessed between.

                          After one: the app plainly opened and the user came
                          back, so telling them it may not be installed is
                          simply false — and it was the ONLY thing that changed
                          on screen when they returned, because the six-second
                          timer fires around then on iOS, where a backgrounded
                          tab's timers are throttled. The App Store link goes
                          with it: nobody needs to install what they were just
                          standing in. */}
                      {claveSlow && !claveErr && (
                        <div className="flex flex-col items-start gap-1">
                          <span className="text-[11px] text-muted">
                            {claveReturned
                              ? 'Still waiting on Clave. Approve the request if it is showing, or copy its bunker:// URI into Option 2 below.'
                              : 'Still nothing? Clave may not be installed, or this browser may not be handing it the link.'}
                          </span>
                          <ClaveSchemeButton label="Open the Clave app directly" />
                          {!claveReturned && (
                            <span className="text-[11px] text-muted">
                              Don&apos;t have Clave?{' '}
                              <a
                                href={CLAVE_APP_STORE_URL}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-nostr underline underline-offset-2"
                              >
                                get it on the App Store ↗
                              </a>
                            </span>
                          )}
                        </div>
                      )}
                      {claveErr && (
                        <div className="flex flex-col items-start gap-1">
                          <span className="text-[11px] text-nostr/80">
                            {connectionDropped(claveErr)
                              ? 'No answer yet. Tap Open Clave again above — that re-subscribes and re-sends the request in one go. Or copy the bunker:// URI from Clave into Option 2 below, which keeps this page in the foreground the whole time.'
                              : claveErr}
                          </span>
                          {/* Two different failures wear the same face here, and
                              only the user can tell them apart: an ack this page
                              was asleep for, or a request Clave never showed
                              them. Re-tapping the button above covers both — it
                              re-subscribes and asks Clave again in one gesture.
                              The scheme escape belongs here too: if Safari has
                              been told to open clave.casa as a web page, the
                              button above navigates this tab away and the user
                              lands back on THIS error, so tapping it again would
                              only repeat that. This is the way out of the loop.

                              THE COPY NAMES OPTION 2 because this box no longer
                              carries its own paste fallback. Clave's own docs
                              call a pasted `bunker://` the reliable same-device
                              iOS path, and it must stay one sentence away — but
                              a duplicate of Option 2 inside this box is not how
                              you keep it reachable. */}
                          <ClaveSchemeButton label="Nothing opened? Open the Clave app directly" />
                        </div>
                      )}

                    </div>
                  )}

                  {/* Option 1: generate a nostrconnect:// URI / QR.

                      IT STAYS GENERIC AND IT STAYS BEHIND THE BUTTON. Both were
                      tried the other way for one commit, to make this the named
                      "Clave on the web" surface, and both were wrong on the
                      screen rather than in the reasoning:

                      - Heading it "Scan with Clave" names one signer on the one
                        platform where the code is genuinely signer-neutral. A
                        phone can be asked which app it has; a desktop browser
                        cannot, and Primal, nsec.app and Amber pair from this
                        same code.
                      - Preparing the pairing on open put a QR and a ~400-char
                        URI at the top of the modal before the user had chosen
                        anything, which pushed Option 2 off the bottom of the
                        viewport entirely — measured at 954x906. It also opened
                        two relay sockets and wrote `bmb:nc_pending` for someone
                        who may only have come to paste a bunker URI.

                      The iOS box above is the opposite case and is right as it
                      is: one signer, named, prepared ahead of the tap, because
                      an anchor's href has to exist before it is tapped. */}
                  <div className="border border-bone/15 p-3 flex flex-col gap-2">
                    <h4 className="font-display text-sm">Option 1: Scan QR Code</h4>
                    <p className="text-[11px] text-muted">
                      Generate a connection QR code to scan (or paste) with your
                      signer app — works with Primal, Clave, nsec.app, Amber.
                    </p>
                    {!genUri && (
                      <button
                        onClick={onGenerate}
                        disabled={genBusy}
                        className="btn-bolt self-start disabled:opacity-40"
                      >
                        {genBusy ? 'Generating…' : 'Generate QR Code'}
                      </button>
                    )}
                    {genUri && (
                      <>
                        <div className="self-stretch flex justify-center bg-bone p-3">
                          <QRCodeSVG
                            value={genUri}
                            size={200}
                            level="M"
                            fgColor="#0a0a08"
                            bgColor="#f5f1e8"
                          />
                        </div>
                        <code className="block w-full bg-ink/40 p-2 text-[10px] leading-snug break-all select-all">
                          {genUri}
                        </code>
                        <div className="flex items-center gap-2">
                          <button onClick={copyGenUri} className="btn-ghost text-[10px] py-1 px-2">
                            {copied ? 'Copied' : 'Copy'}
                          </button>
                          {!genBusy && genErr && (
                            <button onClick={onGenerate} className="btn-bolt text-[10px] py-1 px-2">
                              Try again
                            </button>
                          )}
                          <span className="text-[10px] text-muted">
                            {genBusy ? 'Waiting for signer…' : ''}
                          </span>
                        </div>
                      </>
                    )}
                    {genAuthUrl && (
                      <div className="flex flex-col items-start gap-1 mt-1 border border-nostr/40 bg-nostr/10 p-2">
                        <span className="text-[10px] text-bone">
                          Your signer wants you to approve this connection.
                        </span>
                        <a
                          href={genAuthUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn-bolt text-[11px] py-1 px-3 no-underline"
                        >
                          ◆ Approve in signer
                        </a>
                        <span className="text-[10px] text-muted">
                          Keep this open while you approve.
                        </span>
                      </div>
                    )}
                    {genErr && (
                      <span className="text-[10px] text-nostr/80">
                        {connectionDropped(genErr)
                          ? 'Connection dropped — approve in your signer then tap Try again.'
                          : genErr}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 text-[10px] text-muted">
                    <span className="flex-1 border-t border-bone/15" />
                    <span>OR</span>
                    <span className="flex-1 border-t border-bone/15" />
                  </div>

                  {/* Option 2: paste a bunker:// URI the signer generated. */}
                  <div className="border border-bone/15 p-3 flex flex-col gap-2">
                    <h4 className="font-display text-sm">Option 2: Paste Bunker URI</h4>
                    <p className="text-[11px] text-muted">
                      Paste a <code className="text-[9px]">bunker://</code> URI (or{' '}
                      <code className="text-[9px]">name@example.com</code>) from your
                      signer app — e.g. Clave on iOS, nsec.app, or Amber in server
                      mode.
                    </p>
                    <div className="flex gap-2">
                      <input
                        value={pasteValue}
                        onChange={(e) => setPasteValue(e.target.value)}
                        placeholder="bunker://…"
                        className="input flex-1 text-[11px] break-all"
                      />
                      {/* One tap instead of six. This lived in the iOS Clave box
                          as "2. Paste from Clave", beside its own "1. Open
                          Clave" — a second copy of this very section, for one
                          signer. The convenience was real and the duplication
                          was not worth it, so it moved here where nsec.app and
                          Amber-in-server-mode get it too. It must be a real
                          click: `readText()` needs transient activation, and
                          iOS renders its own Paste confirmation on top. */}
                      <button
                        onClick={onPasteFromClipboard}
                        disabled={pasteBusy}
                        className="btn-ghost text-[11px] py-1 px-3 disabled:opacity-40"
                      >
                        Paste
                      </button>
                      <button
                        onClick={onPasteSubmit}
                        disabled={pasteBusy || !pasteValue.trim()}
                        className="btn-bolt text-[11px] py-1 px-3 disabled:opacity-40"
                      >
                        {pasteBusy ? 'Connecting…' : 'Connect'}
                      </button>
                    </div>
                    {clipErr && (
                      <span className="text-[10px] text-nostr/80">{clipErr}</span>
                    )}
                    {pasteBusy && (
                      <span className="text-[10px] text-muted">
                        Approve in your signer if prompted, then come back here.
                      </span>
                    )}
                    {pasteAuthUrl && (
                      <div className="flex flex-col items-start gap-1 mt-1 border border-nostr/40 bg-nostr/10 p-2">
                        <span className="text-[10px] text-bone">
                          Your signer wants you to approve this connection.
                        </span>
                        <a
                          href={pasteAuthUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn-bolt text-[11px] py-1 px-3 no-underline"
                        >
                          ◆ Approve in signer
                        </a>
                        <span className="text-[10px] text-muted">
                          Approve in your signer, then come back here. Keep this
                          open — closing it cancels the connection.
                        </span>
                      </div>
                    )}
                    {pasteErr && (
                      <div className="flex flex-col items-start gap-1">
                        <span className="text-[10px] text-nostr/80">
                          {connectionDropped(pasteErr)
                            ? 'Connection dropped — tap Connect again, then approve in your signer once more.'
                            : pasteErr}
                        </span>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </>
        )}

      <div className="p-4 border-t border-bone/15 flex justify-end">
        <button onClick={handleClose} className="btn-ghost">
          Cancel
        </button>
      </div>
    </ModalShell>
  );
}
