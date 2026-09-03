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
  type NostrIdentity,
} from '@/lib/nostr';
import { getLatestPendingAmber, submitManualAmberResult } from '@/lib/nostr/amber';
import { isGoogleAuthConfigured, preloadGis } from '@/lib/nostr/google-auth';
import { useApp } from '@/lib/store';
import { getErrorMessage } from '@/lib/util';
import { AmberCompletion } from './login-methods';
import { GoogleAuthPanel } from './google-auth-panel';

type Tab = 'extension' | 'remote';

// Hand a signer-app URI to Android. An anchor click rather than a bare
// `location.href` assignment, for the reason lib/nostr/amber.ts gives: some
// Android browsers hand a custom scheme to the intent picker reliably from a
// click and silently drop it as a "navigation hint" from an assignment.
function openInSignerApp(uri: string) {
  const a = document.createElement('a');
  a.href = uri;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
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
        openInSignerApp(uri);
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
    if (typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') onGenerate();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, genErr, genBusy]);

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
  }, [tab, pasteErr, pasteBusy]);

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
                  <p className="text-xs text-muted">
                    Connect using a remote signer like Primal (iOS/Android), Amber
                    (Android), or any NIP-46 compatible app.
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
                          {amberNcErr.includes('timed out') || amberNcErr.includes('subscription closed')
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
                        {genErr.includes('subscription closed') || genErr.includes('timed out')
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
                      signer app — e.g. nsec.app or Amber in server mode.
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
                          {pasteErr.includes('timed out') || pasteErr.includes('subscription closed')
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
