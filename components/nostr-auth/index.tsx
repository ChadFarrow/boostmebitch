'use client';
import { useEffect, startTransition } from 'react';
import { nip19 } from 'nostr-tools';
import {
  loginWithExtension,
  restoreAmberSigner,
  restoreBunkerSigner,
  restoreLocalSigner,
  clearAmberSigner,
  clearBunkerSigner,
  clearLocalSigner,
  deactivateLocalSigner,
  fetchProfile,
  fetchRelayList,
  fetchEncryptedMnemonicDetailed,
  publishEncryptedMnemonic,
  fetchEncryptedNwc,
  fetchSettings,
  hydrateFavorites,
  hydrateMutes,
  unionMutedPubkeys,
  type NostrIdentity,
} from '@/lib/nostr';
import { hasSpark, sparkDisconnect, sparkInitFromMnemonic, sparkSeedIsActive } from '@/lib/v4v/spark';
import { hasNwc, saveNwcUri, clearNwcUri, loadNwcUri } from '@/lib/v4v/nwc';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
// Direct import, not the barrel: lib/nostr/follows.ts is deliberately
// store-free to avoid a cycle with lib/store, and it isn't re-exported.
import { resetFollows } from '@/lib/nostr/follows';
import { deriveSparkFromLocalKey } from './provision-spark';
import { AccountMenu } from './account-menu';
import { SignInModal } from './sign-in-modal';
import { markNwcRestored } from '../nwc-wallet';

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
  const setFavoriteEpisodes = useApp((s) => s.setFavoriteEpisodes);
  const resetFavoritesSync = useApp((s) => s.resetFavoritesSync);
  const setMutedPubkeys = useApp((s) => s.setMutedPubkeys);
  // One button opens the sign-in modal, which owns the per-method (extension
  // / remote-signer / Amber) flows and their own busy/error state. Open-state
  // lives in the store so other surfaces (fullscreen player, live chat) can
  // open it without leaving the page.
  const modalOpen = useApp((s) => s.signInOpen);
  const setModalOpen = useApp((s) => s.setSignInOpen);
  const setWalletRestoring = useApp((s) => s.setWalletRestoring);

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
    //
    // Hard cap: if doLoadProfile hangs (e.g. a NIP-44 decrypt call to a
    // suspended iOS extension never resolves), the dedup entry stays in the
    // Map forever and every subsequent sign-in returns the stale promise
    // instead of starting a fresh restore. The race below guarantees the
    // entry is cleaned up within 25s regardless of what hangs inside.
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 25_000));
    const p = Promise.race([doLoadProfile(id), timeout]).finally(() => {
      pendingProfileLoad.delete(id.pubkey);
    });
    pendingProfileLoad.set(id.pubkey, p);
    return p;
  }

  async function doLoadProfile(id: NostrIdentity) {
    // Fast-path NWC restore: if the user just signed out + back in on the same
    // tab, the URI was stashed in sessionStorage at sign-out. Read it back now,
    // before any relay queries, while the signer extension is freshly active.
    // This avoids the iOS issue where nostash's background service worker is
    // killed during the 8+ second relay wait, causing NIP-44 decrypt to hang.
    if (!hasNwc() && typeof sessionStorage !== 'undefined') {
      const sessionUri = sessionStorage.getItem(`bmb:nwc_uri_sess:${id.npub}`);
      if (sessionUri) {
        saveNwcUri(sessionUri);
        storage.nwcBackup.set(id.npub);
        markNwcRestored(id.npub);
        sessionStorage.removeItem(`bmb:nwc_uri_sess:${id.npub}`);
      }
    }

    // Start the local-signer Spark derive HERE, before the relay phase below.
    //
    // It reads nothing off the network: the IndexedDB key, plus `npub` and
    // `pubkey` — and those two are identical on `id` and the `enriched`
    // identity built later, since enriching only adds `profile` and
    // `writeRelays`. So the "fast path" was being gated on a 4s-bounded relay
    // round trip it had no dependency on, and a Google account's wallet took
    // seconds to appear on every reload while the local seed sat right there.
    // The relay-backed half (fetchEncryptedMnemonicDetailed) still runs on `enriched`,
    // where the NIP-65 write relays genuinely matter.
    //
    // The condition is captured ONCE, here: after a successful derive
    // `hasSpark()` flips true, so re-evaluating it below would skip the backup
    // check that exists to notice a user's own pasted seed differing from the
    // derived default.
    const shouldRestoreSpark = !hasSpark() && !storage.sparkOptOut.get(id.npub);

    // Tell the header a wallet is on its way, so it shows "connecting…" rather
    // than offering "Connect wallet" for one the user already has —
    // hasAnyWallet() is false for the whole SDK-import + handshake window.
    //
    // Gated on positive evidence, deliberately. shouldRestoreSpark alone is
    // true for anyone without a connected Spark wallet, including people who
    // have never had one — they'd sit on a false "connecting…" for the length
    // of the backup query and then be told to connect after all. A local
    // signer always derives a wallet from the key it holds, and a cached
    // balance means this npub had one last session; anything else stays quiet.
    const expectWallet = shouldRestoreSpark
      && (storage.signer.get() === 'local' || storage.walletBalance.get(id.npub) !== null);
    if (expectWallet) setWalletRestoring(true);

    const derivedSparkPromise = shouldRestoreSpark
      ? (async () => {
          const m = await deriveSparkFromLocalKey(id).catch(() => null);
          // A failed signer restore (abandonRestoredSession) runs sparkDisconnect(),
          // but if it fired before this init landed the wallet would outlive the
          // session it belongs to — and the next account would inherit it. In
          // practice getKey() fails for both, so this is the belt to that braces.
          if (m && storage.npub.get() !== id.npub) { sparkDisconnect(); return null; }
          return m;
        })()
      : Promise.resolve(null);

    // Fire profile, relay list, favorites, and mutes in parallel. Each has
    // a 4s QUERY_MAX_WAIT_MS bound, so total wall time for this phase is ~4s.
    // Mute/favorites tolerate the bare identity (no writeRelays yet) because
    // resolvePublishRelays falls back to DEFAULT_RELAYS, which is fine for
    // the rare debounced republish path.
    const profilePromise = fetchProfile(id.pubkey).catch(() => null);
    const relayListPromise = fetchRelayList(id.pubkey).catch(() => null);
    const favoritesPromise = hydrateFavorites(id).catch(() => {});
    const mutesPromise = hydrateMutes(id).catch(() => {});

    // Apply profile + relay list as soon as both land. Both feed the
    // identity object, so we wait for them together to avoid two re-renders.
    const [profile, relayList] = await Promise.all([profilePromise, relayListPromise]);
    // A failed signer restore (see abandonRestoredSession) can sign the user
    // out while these queries are in flight. Re-applying the enriched identity
    // would resurrect a session with no window.nostr — the exact state that
    // path exists to fix — and the wallet/settings restores below would then
    // run needing a signer that isn't there. The cached npub is the
    // authoritative "still signed in" flag.
    if (storage.npub.get() !== id.npub) {
      // This return is upstream of where sparkPromise's .finally() clears the
      // flag, so it has to clear it itself — otherwise a session abandoned in
      // this window leaves the header stuck on "connecting…" forever.
      if (expectWallet) setWalletRestoring(false);
      return;
    }
    const enriched: NostrIdentity = { ...id };
    if (profile) enriched.profile = profile;
    if (relayList?.write?.length) enriched.writeRelays = relayList.write;
    if (profile || relayList?.write?.length) setIdentity(enriched);

    // Wallet restores and settings run with the enriched identity so the
    // relay query includes the user's actual NIP-65 write relays. Running
    // them with the bare `id` queries only DEFAULT_RELAYS, silently missing
    // backups published from a session that had custom write relays — the
    // primary reason NWC and Spark failed to auto-restore on mobile.
    const sparkPromise = shouldRestoreSpark
      ? (async () => {
          // Already in flight since before the relay phase above — for a local
          // signer the wallet is typically up by now. Null for every other
          // signer kind, leaving the behaviour below unchanged.
          const derived = await derivedSparkPromise;

          // The backup is still authoritative — a user who pasted their own
          // seed has one that differs from the derived default, and it must
          // win. Only re-init when it actually disagrees, so the common case
          // (never changed wallets) costs nothing beyond the query we were
          // already making.
          const { mnemonic, trustworthy } = await fetchEncryptedMnemonicDetailed(enriched);
          if (mnemonic && mnemonic !== derived) {
            await sparkInitFromMnemonic({ mnemonic, ownerPubkey: id.pubkey });
            return;
          }
          if (mnemonic) return;

          // No backup on the relays, and we derived this wallet from a key we
          // hold: publish one. `provisionSparkFromKey` does this on the
          // new-account branch, but nothing ever did it again — so an account
          // whose signup publish failed, or that predates that publish, kept a
          // working derived wallet with no Nostr copy of it forever. "Restore
          // from Nostr" on a second device found nothing, and the seed was
          // reachable only through OUR derivation label, which no other client
          // reproduces. This is the self-heal; it retries on each sign-in.
          //
          // Four guards, none redundant, because the publish target is a
          // REPLACEABLE event and a wrong one destroys a real backup for good:
          //
          //  - `derived` — only ever publish a seed we derived ourselves this
          //    session. It's null for every non-local signer, so Amber, bunker
          //    and NIP-07 users are untouched; a seed we merely READ is never a
          //    candidate to write back.
          //  - `trustworthy` — the load-bearing one. A bare null means "nobody
          //    had it" OR "nothing answered", and acting on the second would
          //    overwrite the backup of a user whose funded Primal/Blitz seed the
          //    query simply missed.
          //  - `sparkSeedIsActive(derived)` — the query above is capped at 8s and
          //    the wallet modal is reachable throughout. If the user pasted their
          //    own seed in that window, theirs is the live wallet and publishing
          //    the derived one would replace their real backup. Same guard, same
          //    reason, as provisionSparkFromKey.
          //  - the npub re-check — a failed signer restore runs
          //    abandonRestoredSession(); don't publish under a session that has
          //    already been torn down.
          if (!trustworthy || !derived) return;
          if (!sparkSeedIsActive(derived) || storage.npub.get() !== id.npub) return;
          const res = await publishEncryptedMnemonic(enriched, derived);
          if (res.acceptedRelays.length === 0) {
            // Message only, never the error/seed — same rule as the provisioning
            // path. Nothing to do beyond saying so: the next sign-in retries.
            console.warn('[spark] wallet backup backfill reached no relays');
          }
        })().catch(() => {}).finally(() => { if (expectWallet) setWalletRestoring(false); })
      : Promise.resolve();
    // Synced settings: apply the last-used boost rail.
    const settingsPromise = fetchSettings(enriched)
      .then((s) => { if (s?.railPref) storage.railPref.set(s.railPref); })
      .catch(() => {});
    // NWC backup: restore the encrypted connection string if this device has
    // no NWC URI yet.
    const nwcPromise = !hasNwc()
      ? fetchEncryptedNwc(enriched)
          .then((uri) => {
            if (uri) { saveNwcUri(uri); storage.nwcBackup.set(id.npub); markNwcRestored(id.npub); }
          })
          .catch(() => {})
      : Promise.resolve();

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
    // Abandon ONLY the session this restore was actually for.
    //
    // Both restores below are async, and a user can complete a whole sign-in
    // while one is still in flight — completeSignIn writes a fresh `bmb:npub`
    // and a new identity. If the stale restore then resolves false, an
    // unconditional abandonRestoredSession() wipes `bmb:npub`, `bmb:signer`,
    // the identity, favorites and mutes belonging to the sign-in that JUST
    // SUCCEEDED. Re-checking the sentinel makes the teardown a no-op once it's
    // been superseded.
    //
    // Found in production, and it only reproduces on an origin with a past:
    // page load must find a `bmb:npub` + `bmb:signer` to attempt a restore at
    // all, and the restore must then FAIL — e.g. the IndexedDB key belongs to a
    // different identity than the cached npub, which restoreLocalSigner
    // deliberately refuses. On a clean origin the fast path returns before any
    // of this, which is why local testing never saw it. Symptom was brutal to
    // read: the header showed the right npub, Spark came up, favorites loaded,
    // but no avatar and no synced settings ever arrived — because doLoadProfile
    // bails on that same sentinel — and a reload landed you signed out.
    const restoringFor = stored;
    const abandonIfNotSuperseded = () => {
      if (storage.npub.get() !== restoringFor) return; // a newer sign-in owns the session now
      abandonRestoredSession();
    };
    if (signerKindStored === 'amber') {
      restoreAmberSigner(pubkey);
    } else if (signerKindStored === 'bunker') {
      // Bunker reconnect is async (NIP-46 transport handshake). Kick it off
      // in the background; signing operations that race ahead of it will
      // throw, but nothing signs unprompted right after page load. If the
      // reconnect fails, fall all the way back to signed out.
      restoreBunkerSigner().then((ok) => {
        if (!ok) abandonIfNotSuperseded();
      }).catch(abandonIfNotSuperseded);
    } else if (signerKindStored === 'local') {
      // Async like the bunker path, not synchronous like Amber: the key has to
      // come back out of IndexedDB and be decrypted under the origin's
      // non-extractable wrap key. Identity still paints immediately from the
      // cached npub below; only signing waits.
      restoreLocalSigner().then((ok) => {
        if (!ok) abandonIfNotSuperseded();
      }).catch(abandonIfNotSuperseded);
    }
    const bare: NostrIdentity = { pubkey, npub: stored };
    const cachedProfile = storage.profile.get(pubkey);
    if (cachedProfile) bare.profile = cachedProfile;
    setIdentity(bare);
    const cachedFavorites = storage.favorites.get(stored);
    if (Object.keys(cachedFavorites).length > 0) setFavorites(cachedFavorites);
    const cachedFavEpisodes = storage.favoriteEpisodes.get(stored);
    if (Object.keys(cachedFavEpisodes).length > 0) setFavoriteEpisodes(cachedFavEpisodes);
    const cachedMutes = storage.muted.get(stored);
    if (cachedMutes.publicPubkeys.length || cachedMutes.privatePubkeys.length) {
      setMutedPubkeys(unionMutedPubkeys(cachedMutes));
    }
    loadProfile(bare);
    // loadProfile is re-created each render; the effect self-guards on
    // `identity` so listing it would only add no-op re-runs.
  }, [identity, setIdentity, setFavorites, setFavoriteEpisodes, setMutedPubkeys]); // eslint-disable-line react-hooks/exhaustive-deps

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

  /**
   * A signer restore failed after identity already painted from the cached
   * npub. Clearing only the `bmb:signer` sentinel isn't enough: the user looks
   * signed in while window.nostr is undefined, and the next thing that signs
   * dies with a generic error. Fall all the way back to signed out.
   *
   * Deliberately does NOT call clearLocalSigner(): a restore failure can be a
   * transient IndexedDB error, and wiping the wrap key would turn a bad reload
   * into permanent key loss. Explicit sign-out is the only place that erases.
   */
  function abandonRestoredSession() {
    const npub = storage.npub.get();
    // Wallet teardown is NOT optional here, and leaving it out was a real leak.
    // `bmb:nwc_uri` is a single global key and the Spark SDK is a module
    // singleton, so both survive this function. Worse, setting identity to null
    // below makes completeSignIn's cross-identity cleanup guard
    // (`identity && identity.pubkey !== id.pubkey`) false on the NEXT sign-in,
    // so it doesn't clean up either — and the next account boosts through the
    // abandoned one's wallet, with its balance in the header chip.
    if (npub) {
      storage.walletBalance.clear(npub);
      storage.nwcBackup.clear(npub);
    }
    clearNwcUri();
    sparkDisconnect();
    // Nothing is coming back up, so stop the header promising it is.
    setWalletRestoring(false);
    // Drop the polyfill too: a half-restored bunker adapter can be left on
    // window.nostr with a live socket, and a queued local restore could
    // otherwise install a signer *after* this ran. Deliberately NOT
    // clearLocalSigner() — that wipes the wrap key, and a transient IndexedDB
    // error must not become permanent key loss. Explicit sign-out erases.
    clearAmberSigner();
    clearBunkerSigner();
    deactivateLocalSigner();
    storage.signer.clear();
    storage.npub.clear();
    // An in-flight doLoadProfile for this pubkey has already bailed (it
    // re-checks storage.npub); leaving its settled promise in the dedupe map
    // would short-circuit a re-sign-in within 25s and skip hydration entirely.
    pendingProfileLoad.clear();
    setIdentity(null);
    setFavorites({});
    setFavoriteEpisodes({});
    resetFavoritesSync();
    setMutedPubkeys(new Set());
  }

  function signout() {
    // The local signer is the only kind where signing out destroys something:
    // clearLocalSigner wipes the ciphertext AND the non-extractable wrap key,
    // and the only way back in is the same Google account plus the PIN. An
    // extension or bunker sign-out costs nothing, so it stays one click. Read
    // the kind before the storage.signer.clear() below.
    if (storage.signer.get() === 'local') {
      const ok = window.confirm(
        "Signing out erases this account's key from this browser.\n\n" +
        'You can only get back in with the same Google account and the PIN you set. ' +
        "If you've forgotten the PIN, this account is gone for good.\n\n" +
        'Sign out anyway?',
      );
      if (!ok) return;
    }
    if (identity) {
      storage.walletBalance.clear(identity.npub);
      // Stash the NWC URI in sessionStorage before clearing it. On same-account
      // sign-in within the same tab, doLoadProfile reads it back instantly —
      // no relay query or NIP-44 decrypt needed. This avoids the iOS issue where
      // the nostash extension background is killed during the long relay wait,
      // causing the NIP-44 decrypt to hang and the restore to silently fail.
      // sessionStorage is cleared automatically on tab close, and the key is
      // per-npub so it can't leak to a different account signing in.
      const nwcUri = loadNwcUri();
      if (nwcUri && typeof sessionStorage !== 'undefined') {
        try { sessionStorage.setItem(`bmb:nwc_uri_sess:${identity.npub}`, nwcUri); } catch {}
      }
      clearNwcUri();
      storage.nwcBackup.clear(identity.npub);
    }
    sparkDisconnect();
    setWalletRestoring(false);
    setIdentity(null);
    setFavorites({});
    setFavoriteEpisodes({});
    resetFavoritesSync();
    setMutedPubkeys(new Set());
    // Same reason as the identity-switch path: useFollows resets this when
    // identity goes null, but not until a FollowButton's effect runs.
    resetFollows();
    storage.npub.clear();
    storage.signer.clear();
    clearAmberSigner();
    clearBunkerSigner();
    // Wipes the ciphertext AND the wrap key, so nothing left behind can
    // decrypt a later blob.
    clearLocalSigner().catch(() => { /* storage already gone */ });
  }

  if (identity) {
    return <AccountMenu identity={identity} onSignOut={signout} />;
  }

  // Common sign-in completion path used by the modal's extension / Amber /
  // remote-signer flows. The login function has already
  // installed whichever polyfill it needs and persisted bmb:bunker /
  // amber state; we just propagate identity to the store and hydrate.
  function completeSignIn(id: NostrIdentity, kind: 'extension' | 'amber' | 'bunker' | 'local') {
    // Switching to a different npub — disconnect the previous wallets so they
    // don't leak across identities. NWC's global URI is cleared here so the
    // new identity's own backup restores cleanly in loadProfile (!hasNwc()).
    if (identity && identity.pubkey !== id.pubkey) {
      storage.walletBalance.clear(identity.npub);
      sparkDisconnect();
      clearNwcUri();
      storage.nwcBackup.clear(identity.npub);

      // Wipe in-memory identity state too, not just the wallets. This is
      // load-bearing beyond the obvious "don't show A's favorites under B":
      // hydrateFavorites reads `useApp.getState().favorites` — deliberately, so
      // a signed-OUT user's favorites get adopted when they first sign in — and
      // when the incoming identity has no shared list yet it PUBLISHES whatever
      // it finds there as that identity's list. Carrying A's favorites into B
      // therefore doesn't just display wrong, it writes A's list to relays
      // under B's key. Clearing here is what keeps that adoption path safe,
      // because it only ever runs on an identity SWITCH — signed-out → signed-in
      // leaves `identity` null, skips this block, and still adopts as intended.
      //
      // hydrateMutes reads the per-npub cache instead, so it's already correct;
      // clearing keeps the two consistent and avoids showing A's mutes in the
      // window before B's hydration lands.
      setFavorites({});
      setFavoriteEpisodes({});
      // The relay-health flag is per-account too: without this, B inherits A's
      // "couldn't reach the relays" notice over B's own freshly-hydrated list.
      resetFavoritesSync();
      setMutedPubkeys(new Set());
      // The follow singleton is module state shared by every FollowButton.
      // ensureFollowsLoaded resets it on an identity change, but only once a
      // button mounts and its effect runs — until then followsSnapshot() still
      // reports A's list, and a stale `ok:true` is what gates the publish path.
      resetFollows();
    }
    startTransition(() => setIdentity(id));
    storage.npub.set(id.npub);
    if (kind === 'amber') storage.signer.set('amber');
    else if (kind === 'bunker') storage.signer.set('bunker');
    else if (kind === 'local') storage.signer.set('local');
    else storage.signer.clear();
    loadProfile(id);
  }

  // Signed out: render only the modal. The visible "Sign in" trigger lives in
  // <AuthControl> (the combined header login), which flips signInOpen in the
  // store. Keeping the modal owned here preserves completeSignIn + all the
  // identity-hydration effects above.
  return modalOpen ? (
    <SignInModal
      onClose={() => setModalOpen(false)}
      onSuccess={(id, kind) => completeSignIn(id, kind)}
    />
  ) : null;
}
