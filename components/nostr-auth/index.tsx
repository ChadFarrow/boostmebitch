'use client';
import { useEffect, useState, startTransition } from 'react';
import { nip19 } from 'nostr-tools';
import {
  loginWithExtension,
  restoreAmberSigner,
  restoreBunkerSigner,
  clearAmberSigner,
  clearBunkerSigner,
  fetchProfile,
  fetchRelayList,
  fetchEncryptedMnemonic,
  fetchEncryptedNwc,
  fetchSettings,
  hydrateFavorites,
  hydrateMutes,
  unionMutedPubkeys,
  type NostrIdentity,
} from '@/lib/nostr';
import { hasSpark, sparkDisconnect, sparkInitFromMnemonic } from '@/lib/v4v/spark';
import { hasNwc, saveNwcUri, clearNwcUri } from '@/lib/v4v/nwc';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { getErrorMessage } from '@/lib/util';
import { AccountMenu } from './account-menu';
import { SignInModal } from './sign-in-modal';

// Module-level promise cache keyed by pubkey, so the same loadProfile call
// isn't fired twice when React remounts the component (StrictMode in dev,
// Fast Refresh on every save).
const pendingProfileLoad = new Map<string, Promise<void>>();

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
  // One button opens the sign-in modal, which owns the per-method (extension
  // / remote-signer / Amber) flows and their own busy/error state.
  const [modalOpen, setModalOpen] = useState(false);

  async function loadProfile(id: NostrIdentity) {
    // Dedupe across remounts (StrictMode runs effects twice in dev; Fast
    // Refresh re-runs them on every save). Without this, a returning user
    // re-fetches profile/relay-list/favorites/wallet every keystroke.
    const existing = pendingProfileLoad.get(id.pubkey);
    if (existing) return existing;
    // Delete the entry once it settles so the dedup only covers *concurrent*
    // loads. Keeping a resolved promise forever meant a sign-out → sign-in
    // with the SAME pubkey (e.g. Alby then Primal on one account) short-
    // circuited here and never re-applied the profile to the fresh bare
    // identity — the header stuck on "Anon" despite the profile being cached.
    const p = doLoadProfile(id).finally(() => {
      pendingProfileLoad.delete(id.pubkey);
    });
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
    // Synced settings: apply the last-used boost rail (relay is the source of
    // truth on a fresh device; local edits this session re-publish and win).
    const settingsPromise = fetchSettings(id)
      .then((s) => { if (s?.railPref) storage.railPref.set(s.railPref); })
      .catch(() => {});
    // NWC backup: restore the encrypted connection string if the user opted
    // in on another device and this device has no NWC URI yet. Mirrors Spark.
    const nwcPromise = !hasNwc()
      ? fetchEncryptedNwc(id)
          .then((uri) => {
            if (uri) { saveNwcUri(uri); storage.nwcBackup.set(id.npub); }
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
    await Promise.allSettled([favoritesPromise, mutesPromise, sparkPromise, settingsPromise, nwcPromise]);
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

  function signout() {
    if (identity) {
      storage.walletBalance.clear(identity.npub);
      // Clear the NWC connection too: bmb:nwc_uri is a single GLOBAL key, so
      // a credential left behind would be inherited by the next account that
      // signs in on this device (and would block that account's own restore,
      // gated on !hasNwc()). The per-npub backup flag goes with it.
      clearNwcUri();
      storage.nwcBackup.clear(identity.npub);
    }
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

  // Common sign-in completion path used by the modal's extension / Amber /
  // remote-signer flows. The login function has already
  // installed whichever polyfill it needs and persisted bmb:bunker /
  // amber state; we just propagate identity to the store and hydrate.
  function completeSignIn(id: NostrIdentity, kind: 'extension' | 'amber' | 'bunker') {
    // Switching to a different npub — disconnect the previous wallets so they
    // don't leak across identities. NWC's global URI is cleared here so the
    // new identity's own backup restores cleanly in loadProfile (!hasNwc()).
    if (identity && identity.pubkey !== id.pubkey) {
      storage.walletBalance.clear(identity.npub);
      sparkDisconnect();
      clearNwcUri();
      storage.nwcBackup.clear(identity.npub);
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
      <button onClick={() => setModalOpen(true)} className="btn-ghost">
        <span className="text-nostr">◆</span>
        <span>Sign in with Nostr</span>
      </button>
      {modalOpen && (
        <SignInModal
          onClose={() => setModalOpen(false)}
          onSuccess={(id, kind) => completeSignIn(id, kind)}
        />
      )}
    </div>
  );
}
