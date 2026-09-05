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
  claimClaveHandoff,
  clearClaveHandoff,
  looksLikeBunkerInput,
  CLAVE_APP_STORE_URL,
  CLAVE_OPEN_URL,
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
  const [tab, setTab] = useState<Tab>(() => (hasExt ? 'extension' : 'remote'));
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
  // The header row already launched Clave inside its own click — it had to, for
  // the transient activation. This modal's job is to be the screen that was
  // missing: subscribe to the same pairing, show the waiting state, and own the
  // retry. Read once, never subscribed, for the same reason `googleOpen` is.
  const [claveIntent] = useState(() => useApp.getState().signInIntent === 'clave');

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
  // The clipboard route into the bunker:// fallback — see onPasteFromClave.
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

  async function onAmberConnect() {
    const attempt = ++amberNcAttempt.current;
    const isCurrent = () => amberNcAttempt.current === attempt;
    setAmberNcBusy(true);
    setAmberNcErr(null);
    try {
      const { uri, ready } = loginWithNostrConnect((url) => setGenAuthUrl(url));
      if (amberNcOpened.current !== uri) {
        amberNcOpened.current = uri;
        openAppLink(uri);
      }
      const id = await ready;
      // A superseded attempt that wins its race anyway must not sign in a second
      // time; the newest attempt owns the session.
      if (!isCurrent()) return;
      onSuccess(id, 'bunker');
      onClose();
    } catch (e) {
      if (!isCurrent()) return;
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

  async function onClaveConnect() {
    const attempt = ++claveAttempt.current;
    const isCurrent = () => claveAttempt.current === attempt;
    setClaveBusy(true);
    setClaveErr(null);
    setClaveSlow(false);
    if (claveSlowTimer.current) clearTimeout(claveSlowTimer.current);
    claveSlowTimer.current = setTimeout(() => {
      if (isCurrent()) setClaveSlow(true);
    }, CLAVE_SLOW_MS);
    try {
      const { uri, ready } = loginWithNostrConnect((url) => setClaveAuthUrl(url));
      // Claimed once per URI, across BOTH launch sites (this and the header
      // row). A retry — the visibility effect below, or a second tap —
      // re-subscribes without sending the user back to an app they have already
      // approved in.
      //
      // The Universal Link is the primary: no "Open in Clave?" sheet, and a
      // visible landing page rather than silence when the app is absent. The
      // custom scheme stays reachable from the control below it, for the one
      // failure this cannot report — see lib/nostr/clave.ts.
      claveUriRef.current = uri;
      if (claimClaveHandoff(uri)) openAppLink(claveUniversalLink(uri));
      const id = await ready;
      if (!isCurrent()) return;
      onSuccess(id, 'bunker');
      onClose();
    } catch (e) {
      if (!isCurrent()) return;
      setClaveErr(getErrorMessage(e, 'Clave connection failed'));
    } finally {
      if (isCurrent()) {
        setClaveBusy(false);
        if (claveSlowTimer.current) { clearTimeout(claveSlowTimer.current); claveSlowTimer.current = null; }
      }
    }
  }

  /**
   * Take the `bunker://` URI straight off the clipboard.
   *
   * This is the fallback Clave's own docs call the reliable one on iOS, and it
   * was the slowest thing in this modal: open Clave, copy, come back, tap the
   * field, long-press, Paste, tap Connect. Reading the clipboard collapses that
   * to one tap plus iOS' own paste confirmation.
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
  async function onPasteFromClave() {
    setClipErr(null);
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      // Denied, unsupported, or no activation left. The paste box below still
      // works, so say that rather than describing a permission screen.
      setClipErr('Could not read the clipboard — paste the URI under Option 2 below.');
      return;
    }
    const trimmed = text.trim();
    if (!looksLikeBunkerInput(trimmed)) {
      setClipErr('That does not look like a bunker:// URI. Copy it in Clave, then tap again.');
      return;
    }
    // Hand it to the existing paste flow rather than a second one, so the box
    // below shows what is being connected and one code path owns the errors.
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
   * Retry the launch through the CUSTOM SCHEME instead of the Universal Link.
   *
   * The failure this exists for is invisible from here and has no other cure:
   * tapping the "clave.casa" breadcrumb in Safari's top-right once tells iOS to
   * stop routing that domain to the app, permanently and with no UI to undo it.
   * The page cannot detect it — the Universal Link simply renders a web page —
   * so the user is the only one who can say "it opened a website, not the app".
   * `clave://` is unaffected by that setting.
   */
  function onOpenClaveScheme() {
    const uri = claveUriRef.current;
    if (!uri) return;
    openAppLink(claveOpenLink(uri));
  }

  /**
   * Send the user back to Clave on the SAME pairing.
   *
   * The ordinary retry deliberately does not re-launch — a user who already
   * approved should not be bounced into the app again. But the other failure is
   * real and looks identical from here: iOS suspended this page's WebSocket
   * during the app switch, the ack was lost, and the user never got a prompt to
   * approve. kind:24133 is ephemeral, so re-subscribing cannot replay it. The
   * only way out is to ask Clave again, and that has to be the user's call
   * because only they know whether they saw a prompt.
   */
  function onReopenClave() {
    clearClaveHandoff();
    onClaveConnect();
  }

  async function onGenerate() {
    setGenBusy(true);
    setGenErr(null);
    setGenAuthUrl(null);
    // Don't clear genUri — loginWithNostrConnect's session memo returns the
    // same URI on retry, so the QR the user already scanned stays valid.
    setCopied(false);
    try {
      const { uri, ready } = loginWithNostrConnect((url) => setGenAuthUrl(url));
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
      if (document.visibilityState === 'visible') onClaveConnect();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, claveErr, claveBusy, genBusy, pasteBusy]);

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
      if (document.visibilityState === 'visible') onAmberConnect();
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

  // Pick up the handshake the header row started. `startClaveSignIn` deliberately
  // dropped its own promise, so nothing is awaiting the ack until this runs —
  // and `claimClaveHandoff` has already been taken for that URI, so this
  // subscribes without launching Clave a second time.
  useEffect(() => {
    // `ios` as well as the intent: the box that reports this attempt only
    // renders on iOS, so without it a stray intent would leave a request in
    // flight with no screen attached to it — busy state nobody can see or cancel.
    if (!claveIntent || !ios) return;
    onClaveConnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claveIntent, ios]);

  // The "may not be installed" timer is the one thing here that outlives the
  // render if nobody clears it: it fires setState on an unmounted modal after
  // the user gives up and closes.
  useEffect(() => () => {
    if (claveSlowTimer.current) clearTimeout(claveSlowTimer.current);
  }, []);

  function handleClose() {
    // Drop any half-finished paste/generate attempt so a future session
    // starts clean.
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
                        onClick={onAmberConnect}
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
                      <button
                        onClick={onClaveConnect}
                        disabled={claveBusy}
                        className="btn-bolt w-full disabled:opacity-40"
                      >
                        {claveBusy ? 'Waiting for Clave…' : 'Sign in with Clave'}
                      </button>
                      {claveBusy && (
                        <span className="text-[11px] text-muted">
                          Approve the connection in Clave, then come back here — this
                          page finishes on its own. Nothing to paste.
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
                      {/* Two different nothings, and neither reports itself.
                          The app may be missing, or Safari may have been told
                          once — by a tap on the clave.casa breadcrumb — to stop
                          routing that domain to the app, which no page can
                          detect. A timer is the only signal either produces, so
                          both answers are offered rather than guessed between. */}
                      {claveSlow && claveBusy && (
                        <div className="flex flex-col items-start gap-1">
                          <span className="text-[11px] text-muted">
                            Still nothing? If a web page opened instead of the app,
                            try the direct link:
                          </span>
                          <button
                            onClick={onOpenClaveScheme}
                            className="btn-ghost text-[10px] py-1 px-2"
                          >
                            Open the Clave app directly
                          </button>
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
                        </div>
                      )}
                      {claveErr && (
                        <div className="flex flex-col items-start gap-1">
                          <span className="text-[11px] text-nostr/80">
                            {connectionDropped(claveErr)
                              ? 'No answer yet. If you approved in Clave, tap Sign in with Clave again — if you never saw a prompt, send the request again.'
                              : claveErr}
                          </span>
                          {/* Two different failures wear the same face here, and
                              only the user can tell them apart: an ack this page
                              was asleep for, or a request Clave never showed
                              them. The ordinary retry re-subscribes; this one
                              asks Clave again. */}
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              onClick={onReopenClave}
                              className="btn-ghost text-[10px] py-1 px-2"
                            >
                              Send the request to Clave again
                            </button>
                            {/* AND the scheme escape belongs HERE, not only in
                                the timed hint above. If Safari has been told to
                                open clave.casa as a web page, the Universal Link
                                navigates this tab away; the user comes back to
                                THIS error, and "send again" would only navigate
                                them away a second time. This is the way out of
                                that loop. */}
                            <button
                              onClick={onOpenClaveScheme}
                              className="btn-ghost text-[10px] py-1 px-2"
                            >
                              Opened a web page? Open the app
                            </button>
                          </div>
                        </div>
                      )}

                      {/* The fallback, and the reason it is one tap rather than a
                          copy-paste chore. Clave's own compatibility doc
                          recommends a bunker:// URI for same-device iOS pairing,
                          because that flow keeps THIS page in the foreground and
                          Safari never suspends the WebSocket the handshake rides
                          on. We lead with the deep link because it is faster when
                          it works — but the vendor-recommended path has to be
                          right here, and it has to not feel like work. */}
                      <div className="border-t border-bone/15 pt-2 mt-1 flex flex-col gap-1.5">
                        <span className="text-[10px] text-muted">
                          Nothing came back? Copy the <code className="text-[9px]">bunker://</code>{' '}
                          URI from Clave instead — this page stays open the whole time.
                        </span>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            onClick={() => openAppLink(CLAVE_OPEN_URL)}
                            className="btn-ghost text-[10px] py-1 px-2"
                          >
                            1. Open Clave
                          </button>
                          <button
                            onClick={onPasteFromClave}
                            disabled={pasteBusy}
                            className="btn-bolt text-[10px] py-1 px-2 disabled:opacity-40"
                          >
                            {pasteBusy ? 'Connecting…' : '2. Paste from Clave'}
                          </button>
                        </div>
                        {clipErr && (
                          <span className="text-[10px] text-nostr/80">{clipErr}</span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Option 1: generate a nostrconnect:// URI / QR. */}
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
                      <button
                        onClick={onPasteSubmit}
                        disabled={pasteBusy || !pasteValue.trim()}
                        className="btn-bolt text-[11px] py-1 px-3 disabled:opacity-40"
                      >
                        {pasteBusy ? 'Connecting…' : 'Connect'}
                      </button>
                    </div>
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
