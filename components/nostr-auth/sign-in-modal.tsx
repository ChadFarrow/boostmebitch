'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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
import { getErrorMessage } from '@/lib/util';
import { AmberCompletion } from './login-methods';

type Tab = 'extension' | 'remote';

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
  onSuccess: (id: NostrIdentity, kind: 'extension' | 'amber' | 'bunker') => void;
}) {
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [hasExt] = useState(() => typeof window !== 'undefined' && !!window.nostr);
  const [android] = useState(() => isLikelyAndroid());
  const [tab, setTab] = useState<Tab>(() => (hasExt ? 'extension' : 'remote'));

  // Browser-extension flow.
  const [extBusy, setExtBusy] = useState(false);
  const [extErr, setExtErr] = useState<string | null>(null);
  // Amber flow.
  const [amberBusy, setAmberBusy] = useState(false);
  const [amberErr, setAmberErr] = useState<string | null>(null);
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

  useEffect(() => setPortalTarget(document.body), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') handleClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  if (!portalTarget) return null;

  const tabClass = (active: boolean) =>
    `flex-1 px-4 py-3 text-sm transition ${
      active
        ? 'text-nostr border-b-2 border-nostr -mb-px'
        : 'text-muted hover:text-bone'
    }`;

  return createPortal(
    <div className="fixed inset-0 z-[60] bg-ink/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="card w-full max-w-md bg-ink relative max-h-[92vh] overflow-y-auto">
        <button
          onClick={handleClose}
          className="absolute top-2 right-3 text-muted hover:text-bone text-lg z-10"
          aria-label="Close"
        >
          ×
        </button>

        <div className="p-5 border-b border-bone/15">
          <div className="stamp text-nostr border-nostr/60 mb-2">◆ NOSTR</div>
          <h3 className="font-display text-2xl leading-tight">Sign in with Nostr</h3>
        </div>

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
                    onClick={onAmber}
                    disabled={amberBusy}
                    className="btn-bolt w-full disabled:opacity-40"
                  >
                    {amberBusy ? 'Connecting…' : 'Sign in with Amber'}
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

        <div className="p-4 border-t border-bone/15 flex justify-end">
          <button onClick={handleClose} className="btn-ghost">
            Cancel
          </button>
        </div>
      </div>
    </div>,
    portalTarget,
  );
}
