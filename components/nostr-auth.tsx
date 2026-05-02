'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { nip19 } from 'nostr-tools';
import {
  loginWithExtension,
  loginWithAmber,
  loginWithBunker,
  loginWithNostrConnect,
  restoreAmberSigner,
  restoreBunkerSigner,
  clearAmberSigner,
  clearBunkerSigner,
  isLikelyAndroid,
  isLikelyIOS,
  subscribeBunkerHealth,
  shortNpub,
  fetchProfile,
  fetchRelayList,
  fetchEncryptedMnemonic,
  hydrateFavorites,
  hydrateMutes,
  unionMutedPubkeys,
  type NostrIdentity,
  type ProfileMetadata,
} from '@/lib/nostr';
import { getLatestPendingAmber, submitManualAmberResult, subscribeAmberStage } from '@/lib/nostr/amber';
import { hasSpark, sparkInitFromMnemonic, subscribeSpark } from '@/lib/v4v/spark';
import { hasNwc, subscribeNwc } from '@/lib/v4v/nwc';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { getErrorMessage } from '@/lib/util';
import { Avatar } from './avatar';
import { WalletModal } from './wallet-modal';

// Module-level promise cache keyed by pubkey, so the same loadProfile call
// isn't fired twice when React remounts the component (StrictMode in dev,
// Fast Refresh on every save).
const pendingProfileLoad = new Map<string, Promise<void>>();

// Detect which NIP-07 extension is installed (if any). We only have a
// reliable signal for Alby — it injects `window.alby` alongside
// `window.nostr`. nos2x and Flamingo only inject `window.nostr` so we
// can't tell them apart from each other or from a plain "some
// extension" install. Returns null when no extension is present.
function detectExtensionBrand(): 'alby' | 'generic' | null {
  if (typeof window === 'undefined') return null;
  if (!window.nostr) return null;
  if ((window as { alby?: unknown }).alby) return 'alby';
  return 'generic';
}

// How long to wait between consecutive `getPublicKey()` checks during
// the account-change detector. Each call may prompt the extension if
// the user hasn't granted "always allow," so we don't want to fire on
// every focus event.
const EXTENSION_RECHECK_THROTTLE_MS = 30_000;

export function NostrAuth() {
  const identity = useApp((s) => s.identity);
  const setIdentity = useApp((s) => s.setIdentity);
  const setFavorites = useApp((s) => s.setFavorites);
  const setMutedPubkeys = useApp((s) => s.setMutedPubkeys);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Detected synchronously on first client render: which (if any) NIP-07
  // extension is at window.nostr, and whether we look Android. Both gate
  // which sign-in path the click takes and how the button labels itself,
  // so we read in the useState initializer (not a useEffect) — otherwise
  // the SSR'd "Sign in with Nostr" paints first and flips after mount,
  // producing a visible flicker on every reload. SSR sees no `window` /
  // `navigator` and returns nothing; the brief hydration mismatch on the
  // button label is suppressed in the JSX below.
  //
  // `extensionBrand` is settable so we can re-detect after mount: a user
  // who installs Alby while the page is already open should see the
  // label update on focus without a manual reload.
  const [extensionBrand, setExtensionBrand] =
    useState<'alby' | 'generic' | null>(detectExtensionBrand);
  const hasExtension = extensionBrand !== null;
  const [android] = useState(() => isLikelyAndroid());
  const [ios] = useState(() => isLikelyIOS());
  // OtherSignIn's `open` state is hoisted up so the primary button can
  // open the disclosure directly when iOS is the active platform — its
  // primary path IS the bunker flow when no NIP-07 extension is detected.
  const [bunkerOpen, setBunkerOpen] = useState(false);

  async function loadProfile(id: NostrIdentity) {
    // Dedupe across remounts (StrictMode runs effects twice in dev; Fast
    // Refresh re-runs them on every save). Without this, a returning user
    // re-fetches profile/relay-list/favorites/wallet every keystroke.
    const existing = pendingProfileLoad.get(id.pubkey);
    if (existing) return existing;
    const p = doLoadProfile(id);
    pendingProfileLoad.set(id.pubkey, p);
    return p;
  }

  async function doLoadProfile(id: NostrIdentity) {
    // Fire all four background refreshes in parallel. Each has a 4s
    // QUERY_MAX_WAIT_MS bound, so total wall time is ~4s, not the 12-16s
    // serialized chain it used to be. Mute hydration depends on the bare
    // identity (npub + pubkey), favorites needs the resolved publish-relay
    // set ideally — but resolvePublishRelays falls back to DEFAULT_RELAYS
    // when writeRelays haven't landed yet, so the rare debounced republish
    // tolerates the race.
    const profilePromise = fetchProfile(id.pubkey).catch(() => null);
    const relayListPromise = fetchRelayList(id.pubkey).catch(() => null);
    const favoritesPromise = hydrateFavorites(id).catch(() => {});
    const mutesPromise = hydrateMutes(id).catch(() => {});
    const sparkPromise = !hasSpark()
      ? fetchEncryptedMnemonic(id)
          .then((mnemonic) => {
            if (mnemonic) return sparkInitFromMnemonic({ mnemonic, ownerPubkey: id.pubkey });
          })
          .catch(() => {})
      : Promise.resolve();

    // Apply profile + relay list as soon as both land. Both feed the
    // identity object, so we wait for them together to avoid two re-renders.
    const [profile, relayList] = await Promise.all([profilePromise, relayListPromise]);
    const enriched: NostrIdentity = { ...id };
    if (profile) enriched.profile = profile;
    if (relayList?.write?.length) enriched.writeRelays = relayList.write;
    if (profile || relayList?.write?.length) setIdentity(enriched);

    // Wait for the rest so the dedup map's resolved promise doesn't release
    // before everything settles (in_flight guards re-entrant remounts).
    await Promise.allSettled([favoritesPromise, mutesPromise, sparkPromise]);
  }

  useEffect(() => {
    // Fast-path: hydrate everything we have cached locally before any relay
    // round-trip so the page paints immediately on reload —
    //   - identity (pubkey/npub) decoded from `bmb:npub`
    //   - kind:0 profile (display name, picture) from storage.profile
    //   - favorites set from storage.favorites
    //   - mute list from storage.muted
    // The signer (window.nostr.signEvent / nip44) isn't called here; it's
    // only needed when an action requires signing and we lazy-call it then.
    // `loadProfile` then runs in the background to refresh from relays.
    if (identity || typeof window === 'undefined') return;
    const stored = storage.npub.get();
    if (!stored) return;
    let pubkey: string;
    try {
      const decoded = nip19.decode(stored);
      if (decoded.type !== 'npub') return;
      pubkey = decoded.data;
    } catch { return; }
    // If the user signed in with Amber, reinstall the AmberSigner polyfill on
    // window.nostr before any signing operation runs. Synchronous; no popup.
    const signerKindStored = storage.signer.get();
    if (signerKindStored === 'amber') {
      restoreAmberSigner(pubkey);
    } else if (signerKindStored === 'bunker') {
      // Bunker reconnect is async (NIP-46 transport handshake). Kick it off
      // in the background; signing operations that race ahead of it will
      // throw, but nothing signs unprompted right after page load. If the
      // reconnect fails, drop the sentinel so the sign-in UI shows again.
      restoreBunkerSigner().then((ok) => {
        if (!ok) storage.signer.clear();
      }).catch(() => storage.signer.clear());
    }
    const bare: NostrIdentity = { pubkey, npub: stored };
    const cachedProfile = storage.profile.get(pubkey);
    if (cachedProfile) bare.profile = cachedProfile;
    setIdentity(bare);
    const cachedFavorites = storage.favorites.get(stored);
    if (Object.keys(cachedFavorites).length > 0) setFavorites(cachedFavorites);
    const cachedMutes = storage.muted.get(stored);
    if (cachedMutes.publicPubkeys.length || cachedMutes.privatePubkeys.length) {
      setMutedPubkeys(unionMutedPubkeys(cachedMutes));
    }
    loadProfile(bare);
  }, [identity, setIdentity, setFavorites, setMutedPubkeys]);

  // Re-detect the NIP-07 extension on focus / visibility changes so a
  // user who installs Alby (or any other extension) while the page is
  // already open sees the button label update without a manual reload.
  // The detection is cheap (just reads window.alby / window.nostr) so
  // we don't throttle.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const recheck = () => {
      const next = detectExtensionBrand();
      setExtensionBrand((cur) => (cur !== next ? next : cur));
    };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, []);

  // Account-change detector for multi-identity NIP-07 extensions
  // (Alby and nos2x both let the user switch active accounts in their
  // own UI). When the tab regains focus we re-call getPublicKey() and,
  // if it differs from the cached identity, re-sign-in with the new
  // pubkey so the rest of the app sees the right user. Only runs on
  // the implicit-extension path — Amber/bunker have their own caching.
  // Throttled to EXTENSION_RECHECK_THROTTLE_MS to avoid hammering the
  // extension (each call may prompt if "always allow" isn't set).
  useEffect(() => {
    if (!identity) return;
    if (typeof window === 'undefined') return;
    if (storage.signer.get() !== null) return;
    if (!window.nostr) return;

    let cancelled = false;
    let lastCheck = 0;

    const onFocus = async () => {
      if (cancelled) return;
      const now = Date.now();
      if (now - lastCheck < EXTENSION_RECHECK_THROTTLE_MS) return;
      lastCheck = now;
      if (!window.nostr) return;
      try {
        const current = await window.nostr.getPublicKey();
        if (cancelled) return;
        if (!current || current === identity.pubkey) return;
        // Extension switched accounts. Re-sign-in fresh — this clears
        // identity/favorites/mutes and re-hydrates against the new
        // pubkey via loadProfile.
        try {
          const newId = await loginWithExtension();
          if (!cancelled) completeSignIn(newId, 'extension');
        } catch {
          // If the second call fails (extension locked, denied), drop
          // identity so the user can sign in fresh manually.
          if (!cancelled) signout();
        }
      } catch {
        // Extension may be locked or have transiently disconnected;
        // ignore and try again next focus.
      }
    };

    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  // Single sign-in entry point. Routes by whatever signer the click
  // actually targets — the button label declares it up front so dispatching
  // to Amber on Android is an explicit choice the user makes, not an
  // invisible default.
  async function signin() {
    setBusy(true); setErr(null);
    try {
      // Re-read window.nostr at click time so a user who just installed
      // an extension (mid-session) doesn't have to reload the page.
      const brandNow = detectExtensionBrand();
      if (brandNow !== extensionBrand) setExtensionBrand(brandNow);
      if (brandNow) {
        completeSignIn(await loginWithExtension(), 'extension');
      } else if (android) {
        completeSignIn(await loginWithAmber(), 'amber');
      } else if (ios) {
        // iOS without a NIP-07 extension — open the bunker disclosure as
        // the primary affordance. The user picks paste vs generate from
        // there. No throw, no error message; the disclosure handles the
        // remaining flow including its own error states.
        setBunkerOpen(true);
      } else {
        throw new Error(
          'No Nostr signer found. Install a NIP-07 extension (Alby, nos2x) or use a remote signer below.',
        );
      }
    } catch (e) {
      setErr(getErrorMessage(e, 'sign-in failed'));
    } finally { setBusy(false); }
  }

  /** Manual-paste fallback for when the auto clipboard read is denied or
   *  the user's setup needs a manual copy step. */
  function submitManualPaste(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (!getLatestPendingAmber()) {
      setErr('No pending Amber request to attach this to.');
      return false;
    }
    return submitManualAmberResult(trimmed);
  }

  function signout() {
    setIdentity(null);
    setFavorites({});
    setMutedPubkeys(new Set());
    storage.npub.clear();
    storage.signer.clear();
    clearAmberSigner();
    clearBunkerSigner();
  }

  if (identity) {
    return <AccountMenu identity={identity} onSignOut={signout} />;
  }

  // The button label declares the signer the click will use: the NIP-07
  // extension if window.nostr is present, otherwise Amber on Android. This
  // way Android-without-extension doesn't silently dispatch to Amber — the
  // user sees "Sign in with Amber" and chooses it explicitly.
  //
  // While an Amber sign-in is in flight, AmberCompletion shows the right
  // affordance for whatever stage the user is in: "approving in Amber" then
  // "tap to read clipboard" once they return (a tap is required because
  // clipboard.readText needs transient user activation, which a
  // visibilitychange event does not grant), with manual-paste as a fallback.
  // 'bunker' is the iOS path: no extension, not Android. Primary click
  // opens the OtherSignIn disclosure instead of erroring with "no signer
  // found." nostash users on iOS Safari land on 'extension' first because
  // their window.nostr injection is detected.
  const signerKind: 'extension' | 'amber' | 'bunker' | 'none' = hasExtension
    ? 'extension'
    : android
      ? 'amber'
      : ios
        ? 'bunker'
        : 'none';
  const buttonLabel = busy
    ? 'Connecting…'
    : extensionBrand === 'alby'
      ? 'Sign in with Alby'
      : signerKind === 'amber'
        ? 'Sign in with Amber'
        : signerKind === 'bunker'
          ? 'Connect remote signer'
          : 'Sign in with Nostr';

  // Common sign-in completion path used by both the primary button and
  // the OtherSignIn (bunker) disclosure. The login function has already
  // installed whichever polyfill it needs and persisted bmb:bunker /
  // amber state; we just propagate identity to the store and hydrate.
  function completeSignIn(id: NostrIdentity, kind: 'extension' | 'amber' | 'bunker') {
    setIdentity(id);
    storage.npub.set(id.npub);
    if (kind === 'amber') storage.signer.set('amber');
    else if (kind === 'bunker') storage.signer.set('bunker');
    else storage.signer.clear();
    loadProfile(id);
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button onClick={signin} disabled={busy} className="btn-ghost">
        <span className="text-nostr">◆</span>
        {/* suppressHydrationWarning: SSR can't read navigator.userAgent, so
            the server pass renders the desktop label and the client pass
            renders the platform-correct one. That's intentional — see the
            useState initializers above. */}
        <span suppressHydrationWarning>{buttonLabel}</span>
      </button>
      {err && <span className="text-[10px] text-nostr/80 max-w-[260px] text-right">{err}</span>}
      {busy && signerKind === 'amber' && <AmberCompletion onSubmit={submitManualPaste} />}
      {signerKind === 'bunker' && !bunkerOpen && (
        <span className="text-[10px] text-muted text-right max-w-[260px]">
          Pair with{' '}
          <a
            href="https://github.com/DocNR/clave"
            target="_blank"
            rel="noopener noreferrer"
            className="text-nostr hover:underline"
          >
            Clave
          </a>{' '}
          (TestFlight) or any NIP-46 signer.
        </span>
      )}
      <OtherSignIn
        open={bunkerOpen}
        onOpenChange={setBunkerOpen}
        onSuccess={(id) => completeSignIn(id, 'bunker')}
        disabled={busy}
        showTrigger={signerKind !== 'bunker'}
      />
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
function AmberCompletion({ onSubmit }: { onSubmit: (value: string) => boolean }) {
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
        setReadErr('Clipboard didn’t look like an Amber result. Paste manually below.');
      }
    } catch (e) {
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
          ? 'If sign-in didn’t complete, tap below.'
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
function OtherSignIn({
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

  async function onGenerate() {
    setGenBusy(true);
    setGenErr(null);
    setGenAuthUrl(null);
    setGenUri(null);
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
    <div className="flex flex-col items-end gap-2 mt-1 max-w-[320px] card p-3">
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
          onClick={() => setOpen(false)}
          className="text-muted hover:text-bone text-base leading-none"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {tab === 'have' && (
        <>
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
            <a
              href={pasteAuthUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-nostr underline break-all self-stretch text-right"
            >
              ◆ Open auth URL to approve
            </a>
          )}
          {pasteErr && (
            <span className="text-[10px] text-nostr/80 text-right">{pasteErr}</span>
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
                <span className="text-[10px] text-muted">
                  {genBusy ? 'Waiting for signer…' : ''}
                </span>
              </div>
            </>
          )}
          {genAuthUrl && (
            <a
              href={genAuthUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-nostr underline break-all self-stretch text-right"
            >
              ◆ Open auth URL to approve
            </a>
          )}
          {genErr && (
            <span className="text-[10px] text-nostr/80 text-right">{genErr}</span>
          )}
        </>
      )}
    </div>
  );
}

// Manual-paste recovery for when Amber's callback URL doesn't reach back to
// the original tab — most commonly when Amber opens the callback in a
// different browser than the one running boostmebitch (e.g. Amber defaults
// to Brave but the app is in Chrome). Renders only while a sign-in is in
// flight; user pastes the pubkey/npub from the Amber-callback tab here.
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

// Surfaced inside AccountMenu when the NIP-46 bunker subscription has
// gone stale (typically because iOS suspended the PWA's WebSocket while
// it was backgrounded). Lives here rather than inside SparkWallet /
// NwcWallet because the failure is signer-side, not wallet-side. The
// reconnect button calls restoreBunkerSigner which reuses the same
// persisted client_sk, so the bunker treats us as the same logical
// client and skips re-auth.
function BunkerHealthBanner() {
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => subscribeBunkerHealth(setStale), []);

  if (!stale) return null;

  async function reconnect() {
    setBusy(true); setErr(null);
    try {
      const ok = await restoreBunkerSigner();
      if (!ok) setErr('Reconnect failed. Try signing out and back in.');
    } catch (e) {
      setErr(getErrorMessage(e, 'reconnect failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-nostr/40 bg-nostr/10 p-2 mb-3 flex flex-col gap-1">
      <span className="text-[11px] text-bone">
        Signer disconnected — your iPhone may have suspended the relay link.
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={reconnect}
          disabled={busy}
          className="btn-ghost text-[10px] py-1 px-2 disabled:opacity-30"
        >
          {busy ? 'Reconnecting…' : 'Reconnect'}
        </button>
        {err && <span className="text-[10px] text-nostr/80">{err}</span>}
      </div>
    </div>
  );
}

function AccountMenu({
  identity,
  onSignOut,
}: {
  identity: NostrIdentity;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Dismiss on click-outside / Escape so the menu doesn't trap focus.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const name = identity.profile?.display_name || identity.profile?.name;
  const pic = identity.profile?.picture;

  return (
    <div ref={wrapperRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="btn-ghost group flex items-center gap-2"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {pic ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={pic}
            alt=""
            className="w-5 h-5 rounded-full object-cover border border-nostr/40 flex-shrink-0"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        ) : (
          <span className="text-nostr">◆</span>
        )}
        <span className="hidden sm:inline truncate max-w-[160px] lg:max-w-[280px]">
          {name || shortNpub(identity.npub, 6)}
        </span>
        <span className="opacity-40 group-hover:opacity-100 transition text-[10px]">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-2 w-[min(360px,calc(100vw-2rem))] card bg-ink p-4 z-30 shadow-xl"
        >
          <div className="border-b border-bone/15 pb-3 mb-3">
            <div className="text-sm">{name || 'Anon'}</div>
            <div className="text-[10px] text-muted truncate">{shortNpub(identity.npub, 8)}</div>
          </div>

          <BunkerHealthBanner />

          <WalletButton onClick={() => setWalletOpen(true)} />

          <MutedAccountsSection />

          <div className="border-t border-bone/15 mt-4 pt-3">
            <button
              onClick={() => { onSignOut(); setOpen(false); }}
              className="text-[11px] text-muted hover:text-nostr"
            >
              sign out
            </button>
          </div>
        </div>
      )}
      {walletOpen && <WalletModal onClose={() => setWalletOpen(false)} />}
    </div>
  );
}

// Single-row summary that replaces the inline NWC / Spark / WebLN cards in
// the account menu. Reads each rail's connect state on every render and
// re-renders on rail-state changes so disconnecting from inside the modal
// flips the summary back to "Not connected" without remounting the menu.
function WalletButton({ onClick }: { onClick: () => void }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const unsubSpark = subscribeSpark(bump);
    const unsubNwc = subscribeNwc(bump);
    return () => { unsubSpark(); unsubNwc(); };
  }, []);

  const sparkReady = hasSpark();
  const nwcReady = hasNwc();
  // Spark is preferred in the summary because it's the richer surface
  // (balance + receive). NWC takes priority over Spark in pickRail() for
  // sending, but here we're describing the user's setup, not routing.
  const summary = sparkReady
    ? 'Spark wallet'
    : nwcReady
      ? 'NWC connected'
      : 'Not connected';
  const connected = sparkReady || nwcReady;

  return (
    <button
      type="button"
      onClick={onClick}
      className="card mt-2 mb-1 p-3 w-full flex items-center justify-between hover:border-bolt/40 transition text-left"
    >
      <span className="flex items-center gap-2">
        <span className={connected ? 'text-bolt text-base' : 'text-muted text-base'}>⚡</span>
        <span className="flex flex-col">
          <span className="text-[11px] uppercase tracking-widest text-muted">Lightning wallet</span>
          <span className="text-sm">{summary}</span>
        </span>
      </span>
      <span className="text-[11px] text-muted">{connected ? 'Manage' : 'Connect'} →</span>
    </button>
  );
}

// Muted accounts (NIP-51 kind:10000). Only renders when there's at least one
// muted pubkey so the menu stays compact for users who haven't used the
// feature. Profile names are best-effort from the kind:0 cache; an unresolved
// pubkey falls back to its short-npub.
function MutedAccountsSection() {
  const mutedPubkeys = useApp((s) => s.mutedPubkeys);
  const unmutePubkey = useApp((s) => s.unmutePubkey);
  const pubkeys = useMemo(() => Array.from(mutedPubkeys), [mutedPubkeys]);
  const [profiles, setProfiles] = useState<Record<string, ProfileMetadata | null>>({});
  const [expanded, setExpanded] = useState(false);

  // Fill from cache synchronously, then resolve any uncached pubkeys in the
  // background. Only runs while the section is expanded — collapsed state
  // doesn't render names so there's no point fetching them. Names cache to
  // localStorage so re-expanding is instant.
  useEffect(() => {
    if (!expanded) return;
    if (pubkeys.length === 0) return;
    const next: Record<string, ProfileMetadata | null> = {};
    const unresolved: string[] = [];
    for (const pk of pubkeys) {
      const cached = storage.profile.get(pk);
      if (cached !== undefined) next[pk] = cached;
      else unresolved.push(pk);
    }
    setProfiles((prev) => ({ ...prev, ...next }));
    if (unresolved.length === 0) return;
    let cancelled = false;
    (async () => {
      const fetched = await Promise.all(
        unresolved.map((pk) =>
          fetchProfile(pk).then((p) => {
            if (p) storage.profile.set(pk, p);
            else storage.profile.setMiss(pk);
            return [pk, p] as const;
          }).catch(() => [pk, null] as const),
        ),
      );
      if (cancelled) return;
      setProfiles((prev) => {
        const merged = { ...prev };
        for (const [pk, p] of fetched) merged[pk] = p;
        return merged;
      });
    })();
    return () => { cancelled = true; };
  }, [pubkeys, expanded]);

  if (pubkeys.length === 0) return null;

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full text-[11px] uppercase tracking-widest text-bone/60 mb-2 flex items-center justify-between gap-2 hover:text-bone"
      >
        <span>Muted accounts ({pubkeys.length})</span>
        <span aria-hidden className="text-bone/60">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
      <ul className="space-y-1.5 max-h-48 overflow-y-auto">
        {pubkeys.map((pk) => {
          const profile = profiles[pk];
          const npub = (() => {
            try { return nip19.npubEncode(pk); } catch { return pk.slice(0, 12); }
          })();
          const name =
            profile?.display_name?.trim() ||
            profile?.name?.trim() ||
            shortNpub(npub, 6);
          return (
            <li key={pk} className="flex items-center gap-2 text-xs">
              <Avatar
                pubkey={pk}
                picture={profile?.picture}
                name={profile?.display_name || profile?.name}
                className="w-6 h-6 rounded-full border border-bone/20 flex-shrink-0 text-[10px]"
              />
              <span className="truncate flex-1" title={npub}>{name}</span>
              <button
                onClick={() => unmutePubkey(pk)}
                className="text-[10px] text-muted hover:text-nostr"
                title="Unmute this account"
              >
                unmute
              </button>
            </li>
          );
        })}
      </ul>
      )}
    </div>
  );
}
