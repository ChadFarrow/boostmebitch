'use client';
import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { loginWithBunker, loginWithNostrConnect, clearPendingBunkerAttempts, type NostrIdentity } from '@/lib/nostr';
import { subscribeAmberStage } from '@/lib/nostr/amber';
import { getErrorMessage } from '@/lib/util';

function AmberManualPaste({ onSubmit }: { onSubmit: (value: string) => boolean }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-[10px] text-muted hover:text-nostr underline mt-1"
      >
        Amber didn&apos;t come back? Paste manually
      </button>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1 mt-1 max-w-[280px]">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Paste pubkey / npub from Amber"
        className="input text-[11px] w-full"
        rows={2}
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen(false)}
          className="text-[10px] text-muted hover:text-bone"
        >
          cancel
        </button>
        <button
          onClick={() => {
            const ok = onSubmit(value);
            if (!ok) setHint('Could not match a pending request.');
            else { setValue(''); setHint(null); }
          }}
          className="btn-ghost text-[10px] py-1 px-2"
        >
          submit
        </button>
      </div>
      {hint && <span className="text-[10px] text-nostr/80">{hint}</span>}
    </div>
  );
}

// While an Amber request is in flight, surface a "Read from clipboard"
// button: tapping it grants the user activation that navigator.clipboard
// .readText needs to succeed. The existing manual-paste form is the
// secondary fallback if the clipboard read is denied or the value doesn't
// match the expected shape.
//
// `returned` is driven by `subscribeAmberStage` — invokeAmber promotes the
// stage to 'returned' on the SAME signals that drive its auto-clipboard
// path (visibilitychange / pageshow / focus / pointerdown / touchstart /
// keydown), so the hint copy and the underlying flow agree. A late mount
// (e.g. after Fast Refresh) gets the current stage on subscribe.
export function AmberCompletion({ onSubmit }: { onSubmit: (value: string) => boolean }) {
  const [returned, setReturned] = useState(false);
  const [readErr, setReadErr] = useState<string | null>(null);

  useEffect(
    () => subscribeAmberStage((stage) => setReturned(stage === 'returned')),
    [],
  );

  async function readClipboard() {
    setReadErr(null);
    try {
      const text = await navigator.clipboard.readText();
      const ok = onSubmit(text);
      if (!ok) {
        setReadErr("Clipboard didn’t look like an Amber result. Paste manually below.");
      }
    } catch {
      setReadErr(
        'Clipboard read denied. Long-press → paste, or use "Paste manually" below.',
      );
    }
  }

  // Recovery UI for Amber. Most of the time `invokeAmber` resolves silently
  // on the first user gesture after return (its capture-phase pointerdown /
  // touchstart / keydown listener reads the clipboard with fresh user
  // activation). What renders here is the safety net for when that read
  // fails — clipboard permission denied, ciphertext that doesn't match the
  // expected shape, or Amber writing into a different browser than the one
  // running the PWA.
  return (
    <div className="flex flex-col items-end gap-1 mt-1 max-w-[280px]">
      <span className="text-[10px] text-muted text-right">
        {returned
          ? "If sign-in didn't complete, tap below."
          : 'Approve in Amber, then come back — sign-in will finish on your next tap.'}
      </span>
      <button onClick={readClipboard} className="btn-ghost text-[10px] py-1 px-2">
        ◆ Read clipboard manually
      </button>
      {readErr && <span className="text-[10px] text-nostr/80 text-right">{readErr}</span>}
      <AmberManualPaste onSubmit={onSubmit} />
    </div>
  );
}

// NIP-46 remote-signer ("bunker") sign-in. Two flows behind a [Have URI] /
// [Generate URI] tab pair:
//
//   - HAVE URI: user pastes a bunker:// URI (or NIP-05 like `name@domain`)
//     copied from their remote signer. We connect, then resolve.
//
//   - GENERATE URI: we build a nostrconnect:// URI for the user to paste
//     into their signer. The signer connects back via the relays embedded
//     in the URI; the promise resolves once it does.
//
// In both cases the underlying loginWithBunker / loginWithNostrConnect
// install the BunkerAdapter as window.nostr and persist the session, so
// the parent component just receives the resolved NostrIdentity and runs
// its usual completeSignIn flow.
export function OtherSignIn({
  open,
  onOpenChange,
  onSuccess,
  disabled,
  showTrigger,
}: {
  /** Controlled open state. When `showTrigger` is false the trigger
   *  button isn't rendered, so the parent must drive `open` via the
   *  primary sign-in click instead. */
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onSuccess: (id: NostrIdentity) => void;
  disabled: boolean;
  /** Whether to render the standalone "◆ Use a remote signer" trigger
   *  button. False on iOS (the primary sign-in button drives this same
   *  disclosure, so the trigger would be redundant). */
  showTrigger: boolean;
}) {
  const setOpen = onOpenChange;
  const [tab, setTab] = useState<'have' | 'generate'>('have');
  const [pasteValue, setPasteValue] = useState('');
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteErr, setPasteErr] = useState<string | null>(null);
  const [pasteAuthUrl, setPasteAuthUrl] = useState<string | null>(null);

  // Generate-flow state. `genUri` is shown verbatim for the user to copy
  // and paste into their signer; `genErr` surfaces parsing / connection
  // failures; `genAuthUrl` mirrors the bunker's onauth callback when
  // reached during the connect handshake.
  const [genUri, setGenUri] = useState<string | null>(null);
  const [genBusy, setGenBusy] = useState(false);
  const [genErr, setGenErr] = useState<string | null>(null);
  const [genAuthUrl, setGenAuthUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function onGenerate() {
    setGenBusy(true);
    setGenErr(null);
    setGenAuthUrl(null);
    // Don't clear genUri — startNostrConnect's session memo returns the
    // same URI on retry, so the QR the user already scanned in Primal
    // remains valid. Clearing it would also flash the "Generate connect
    // URI" button in between attempts.
    setCopied(false);
    try {
      const { uri, ready } = loginWithNostrConnect((url) => setGenAuthUrl(url));
      setGenUri(uri);
      const id = await ready;
      onSuccess(id);
      setOpen(false);
      setGenUri(null);
    } catch (e) {
      setGenErr(getErrorMessage(e, 'nostrconnect failed'));
    } finally {
      setGenBusy(false);
    }
  }

  // iOS Safari suspends WebSocket subscriptions the moment the user
  // backgrounds the tab to scan the URI in Primal. nostr-tools' fromURI
  // raises "subscription closed before connection was established" as
  // soon as that suspension closes the relays. When Safari regains
  // visibility, auto-retry: the memoized URI + clientSk inside
  // startNostrConnect mean Primal sees the same pairing, so an ACK
  // queued on relay.primal.net (Primal's backend publishes it there)
  // can be delivered into the new subscription.
  // Must be declared before the early return below to satisfy React's
  // rules of hooks (hook count must be the same on every render).
  useEffect(() => {
    if (!open) return;
    if (tab !== 'generate') return;
    // Attach whenever the flow is in-flight (genBusy) OR has already failed
    // (genErr). The in-flight case covers iOS Safari suspending the WebSocket
    // while the user switches to Primal to paste the URI — the relay buffers
    // Primal's connect ACK, and a fresh fromURI subscription picks it up on
    // return. The error case covers the existing retry path.
    if (!genBusy && !genErr) return;
    if (typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      onGenerate();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // onGenerate is recreated on every render but only depends on stable
    // setters; capturing the closure at effect-mount is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, genErr, genBusy]);

  // Paste flow: auto-retry on return from Primal. Same pattern as the generate
  // flow above. On iOS, switching to Primal to approve suspends Safari's
  // WebSocket; on return, re-attempt with the same clientSk (pendingClientSks
  // ensures reuse) so Primal recognizes the already-approved client and acks
  // immediately on the fresh subscription.
  useEffect(() => {
    if (!open || tab !== 'have') return;
    if (!pasteBusy && !pasteErr) return;
    if (typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      onPasteSubmit();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, pasteErr, pasteBusy]);

  if (!open) {
    if (!showTrigger) return null;
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="text-[11px] text-bone/70 hover:text-nostr mt-1 disabled:opacity-30 flex items-center gap-1"
      >
        <span className="text-nostr">◆</span>
        Use a remote signer
      </button>
    );
  }

  async function onPasteSubmit() {
    setPasteBusy(true);
    setPasteErr(null);
    setPasteAuthUrl(null);
    try {
      const id = await loginWithBunker(pasteValue, (url) => setPasteAuthUrl(url));
      onSuccess(id);
      setOpen(false);
      setPasteValue('');
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

  return (
    <div className="absolute right-0 top-full mt-1 z-50 flex flex-col items-end gap-2 w-[calc(100vw-1rem)] max-w-[320px] card p-3">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest w-full">
        <button
          type="button"
          onClick={() => setTab('have')}
          className={tab === 'have' ? 'text-bone' : 'text-muted hover:text-bone'}
        >
          Have URI
        </button>
        <span className="text-bone/30">·</span>
        <button
          type="button"
          onClick={() => setTab('generate')}
          className={tab === 'generate' ? 'text-bone' : 'text-muted hover:text-bone'}
        >
          Generate URI
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            // Drop any half-finished paste attempt so a future session
            // starts clean — the memo is keyed on URI but the user may
            // change which signer they're pairing with next time.
            clearPendingBunkerAttempts();
            setOpen(false);
          }}
          className="text-muted hover:text-bone text-base leading-none"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {tab === 'have' && (
        <>
          <span className="text-[10px] text-muted self-stretch text-right">
            Primal: Settings → Keys → Remote Signer → copy the connection
            string. On iOS, enable background audio in Primal first so it
            stays alive for signing requests. After approving in Primal,
            return here and tap <span className="text-bone">Connect</span>{' '}
            again if it didn&apos;t finish — your approval is remembered.
          </span>
          <textarea
            value={pasteValue}
            onChange={(e) => setPasteValue(e.target.value)}
            placeholder="bunker://… or name@example.com"
            rows={3}
            className="input w-full text-[11px] break-all"
          />
          <div className="flex items-center gap-2 self-end">
            <button
              onClick={onPasteSubmit}
              disabled={pasteBusy || !pasteValue.trim()}
              className="btn-bolt text-[11px] py-1 px-3 disabled:opacity-40"
            >
              {pasteBusy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
          {pasteAuthUrl && (
            <div className="self-stretch flex flex-col items-end gap-1 mt-1 border border-nostr/40 bg-nostr/10 p-2">
              <span className="text-[10px] text-bone text-right">
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
              <span className="text-[10px] text-muted text-right">
                Approve in your signer (Primal, Clave, …) then come back here.
                Keep this tab open while you approve — closing it cancels the
                connection.
              </span>
            </div>
          )}
          {pasteErr && (
            <div className="flex flex-col items-end gap-1 self-end">
              <span className="text-[10px] text-nostr/80 text-right">
                {pasteErr.includes('timed out')
                  ? 'Timed out — if you approved in Primal, tap Try again.'
                  : pasteErr}
              </span>
              {pasteErr.includes('timed out') && (
                <button
                  onClick={onPasteSubmit}
                  disabled={pasteBusy || !pasteValue.trim()}
                  className="btn-bolt text-[11px] py-1 px-3 disabled:opacity-40"
                >
                  {pasteBusy ? 'Connecting…' : 'Try again'}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {tab === 'generate' && (
        <>
          {!genUri && !genBusy && (
            <button
              onClick={onGenerate}
              className="btn-bolt text-[11px] py-1 px-3 self-end"
            >
              Generate connect URI
            </button>
          )}
          {genUri && (
            <>
              <span className="text-[10px] text-muted self-stretch text-right">
                Scan with your signer, or copy below.
              </span>
              {/* QR for cross-device handoff (e.g. laptop running the
                  app + phone running Clave / nsec.app). Same color
                  tokens as the Spark deposit-invoice QR for visual
                  consistency. */}
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
              <div className="flex items-center gap-2 self-end">
                <button
                  onClick={copyGenUri}
                  className="btn-ghost text-[10px] py-1 px-2"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
                {!genBusy && genErr && (
                  // The same memoized clientSk + URI is reused inside
                  // startNostrConnect, so the QR the user already scanned
                  // in Primal stays valid and the relay's recent-event
                  // buffer can replay the connect we missed when iOS
                  // suspended Safari.
                  <button
                    onClick={onGenerate}
                    className="btn-bolt text-[10px] py-1 px-2"
                  >
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
            <div className="self-stretch flex flex-col items-end gap-1 mt-1 border border-nostr/40 bg-nostr/10 p-2">
              <span className="text-[10px] text-bone text-right">
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
              <span className="text-[10px] text-muted text-right">
                Keep this tab open while you approve.
              </span>
            </div>
          )}
          {genErr && (
            <span className="text-[10px] text-nostr/80 text-right">{genErr}</span>
          )}
        </>
      )}
    </div>
  );
}
