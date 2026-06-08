'use client';
import { useEffect, useState, startTransition } from 'react';
import { nip19 } from 'nostr-tools';
import {
  loginWithExtension,
  loginWithAmber,
  restoreAmberSigner,
  restoreBunkerSigner,
  clearAmberSigner,
  clearBunkerSigner,
  isLikelyAndroid,
  isLikelyIOS,
  fetchProfile,
  fetchRelayList,
  fetchEncryptedMnemonic,
  hydrateFavorites,
  hydrateMutes,
  unionMutedPubkeys,
  type NostrIdentity,
} from '@/lib/nostr';
import { getLatestPendingAmber, submitManualAmberResult } from '@/lib/nostr/amber';
import { hasSpark, sparkDisconnect, sparkInitFromMnemonic } from '@/lib/v4v/spark';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { getErrorMessage } from '@/lib/util';
import { AccountMenu } from './account-menu';
import { AmberCompletion, OtherSignIn } from './login-methods';

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
    const sparkPromise = !hasSpark() && !storage.sparkOptOut.get()
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
    if (identity) storage.walletBalance.clear(identity.npub);
    sparkDisconnect();
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
    // Switching to a different npub — disconnect the previous Spark wallet
    // so it doesn't leak across identities.
    if (identity && identity.pubkey !== id.pubkey) {
      storage.walletBalance.clear(identity.npub);
      sparkDisconnect();
    }
    startTransition(() => setIdentity(id));
    storage.npub.set(id.npub);
    if (kind === 'amber') storage.signer.set('amber');
    else if (kind === 'bunker') storage.signer.set('bunker');
    else storage.signer.clear();
    loadProfile(id);
  }

  return (
    <div className="relative flex flex-col items-end gap-1">
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
