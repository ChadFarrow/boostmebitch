'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { hasSpark, sparkInitFromMnemonic } from '@/lib/v4v/spark';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { getErrorMessage } from '@/lib/util';
import { Avatar } from './avatar';
import { SparkWallet } from './spark-wallet';
import { NwcWallet } from './nwc-wallet';
import { WeblnWallet } from './webln-wallet';

// Module-level promise cache keyed by pubkey, so the same loadProfile call
// isn't fired twice when React remounts the component (StrictMode in dev,
// Fast Refresh on every save).
const pendingProfileLoad = new Map<string, Promise<void>>();

export function NostrAuth() {
  const identity = useApp((s) => s.identity);
  const setIdentity = useApp((s) => s.setIdentity);
  const setFavorites = useApp((s) => s.setFavorites);
  const setMutedPubkeys = useApp((s) => s.setMutedPubkeys);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Detected synchronously on first client render: whether a NIP-07
  // extension exposed window.nostr, and whether we look Android. Both gate
  // which sign-in path the click takes and how the button labels itself,
  // so we read in the useState initializer (not a useEffect) — otherwise
  // the SSR'd "Sign in with Nostr" paints first and flips to "Sign in
  // with Amber" after mount, producing a visible flicker on every reload
  // for Android users. SSR sees no `window` / `navigator` and returns
  // false for both; the brief hydration mismatch on the button label is
  // suppressed in the JSX below.
  const [hasExtension] = useState(() => typeof window !== 'undefined' && !!window.nostr);
  const [android] = useState(() => isLikelyAndroid());

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

  // Single sign-in entry point. Routes by whatever signer the click
  // actually targets — the button label declares it up front so dispatching
  // to Amber on Android is an explicit choice the user makes, not an
  // invisible default.
  async function signin() {
    setBusy(true); setErr(null);
    try {
      if (hasExtension) {
        completeSignIn(await loginWithExtension(), 'extension');
      } else if (android) {
        completeSignIn(await loginWithAmber(), 'amber');
      } else {
        throw new Error(
          'No Nostr signer found. Install a NIP-07 extension (Alby, nos2x), use Amber on Android, or open the "Other sign-in" panel below for a remote-signer URI.',
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
  const signerKind: 'extension' | 'amber' | 'none' = hasExtension
    ? 'extension'
    : android
      ? 'amber'
      : 'none';
  const buttonLabel = busy
    ? 'Connecting…'
    : signerKind === 'amber'
      ? 'Sign in with Amber'
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
      <OtherSignIn onSuccess={(id) => completeSignIn(id, 'bunker')} disabled={busy} />
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
  onSuccess,
  disabled,
}: {
  onSuccess: (id: NostrIdentity) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
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
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="text-[10px] text-muted hover:text-nostr underline mt-1 disabled:opacity-30"
      >
        Other sign-in (NIP-46 / bunker)
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
                Copy this and paste it into your signer to connect.
              </span>
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

function AccountMenu({
  identity,
  onSignOut,
}: {
  identity: NostrIdentity;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
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
        <span className="hidden sm:inline truncate max-w-[160px]">
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

          <div className="text-[11px] uppercase tracking-widest text-muted">
            Connect wallet
          </div>

          <div className="mt-2 text-[11px] uppercase tracking-widest text-bone/60">NWC</div>
          <NwcWallet />

          <div className="mt-4 text-[11px] uppercase tracking-widest text-bone/60">Spark</div>
          <SparkWallet />

          <div className="mt-4 text-[11px] uppercase tracking-widest text-bone/60">WebLN</div>
          <WeblnWallet />

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
    </div>
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
