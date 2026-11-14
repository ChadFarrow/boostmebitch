'use client';

// Signing out, as ONE function both account menus call — the header's (drawn
// by <NostrAuth>) and the now-playing screen's (<NowPlayingAccountMenu>).
//
// It lived inside <NostrAuth>, and a second menu could only have reached it by
// asking that instance to sign out. That fails on any route that mounts no
// <NostrAuth> — `/privacy` mounts nothing, and the fullscreen player opens over
// every route — and a sign-out control that does nothing there is the dead
// control docs/ui.md keeps paying for. So the function moved, unchanged, into a
// hook: each menu holds a working copy, and the body exists once.
//
// The body is the one <NostrAuth> had, line for line: the `'local'`-only
// confirm (docs/signers.md), the NWC stash into sessionStorage, the store
// resets, the guest Up Next cleared on disk, and `revoke` — HERE AND NOWHERE
// ELSE. The caller renders `confirmEl`, the dialog that confirm draws.

import type { ReactNode } from 'react';
import { useConfirm } from '../confirm-dialog';
import { clearAmberSigner, clearBunkerSigner, clearLocalSigner } from '@/lib/nostr';
import { sparkDisconnect } from '@/lib/v4v/spark';
import { clearNwcUri, loadNwcUri } from '@/lib/v4v/nwc-state';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { cancelQueuedSummaries } from '@/lib/nostr/value-playback';
import { resetFollows } from '@/lib/nostr/follows';

export function useSignOut(): [() => Promise<void>, ReactNode] {
  const identity = useApp((s) => s.identity);
  const setIdentity = useApp((s) => s.setIdentity);
  const [confirm, confirmEl] = useConfirm();
  const setFavorites = useApp((s) => s.setFavorites);
  const setFavoriteEpisodes = useApp((s) => s.setFavoriteEpisodes);
  const setListenQueue = useApp((s) => s.setListenQueue);
  const resetFavoritesSync = useApp((s) => s.resetFavoritesSync);
  const setMutedPubkeys = useApp((s) => s.setMutedPubkeys);
  const setMutesSync = useApp((s) => s.setMutesSync);
  const setWalletRestoring = useApp((s) => s.setWalletRestoring);

  async function signout() {
    // The local signer is the only kind where signing out destroys something:
    // clearLocalSigner wipes the ciphertext AND the non-extractable wrap key,
    // and the only way back in is the same Google account plus the PIN. An
    // extension or bunker sign-out costs nothing, so it stays one click. Read
    // the kind before the storage.signer.clear() below.
    if (storage.signer.get() === 'local') {
      const ok = await confirm({
        title: 'Sign out and erase this key?',
        body: (
          <>
            <p>Signing out erases this account&apos;s key from this browser.</p>
            <p>
              You can only get back in with the same Google account and the PIN you set. If
              you&apos;ve forgotten the PIN, this account is gone for good.
            </p>
          </>
        ),
        confirmLabel: 'Sign out and erase',
        danger: true,
      });
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
      if (nwcUri) storage.nwcSessionUri.set(identity.npub, nwcUri);
      clearNwcUri();
      storage.nwcBackup.clear(identity.npub);
    }
    sparkDisconnect();
    setWalletRestoring(false);
    // Anything queued belongs to the account going away — see flushSummaries.
    cancelQueuedSummaries();
    setIdentity(null);
    setFavorites({});
    setFavoriteEpisodes({});
    resetFavoritesSync();
    setMutedPubkeys(new Set());
    setMutesSync('idle');
    // EMPTY, not the `:guest` bucket. Reading that back would resurrect a
    // queue from some earlier signed-out session on this device, which is
    // nobody's current intent. The account's own key is left on disk
    // untouched, exactly like its favorites cache, so signing back in finds
    // the queue where it was.
    //
    // CLEARING MEMORY IS NOT ENOUGH, and that is what this used to do. The
    // store seeds `listenQueue` from `storage.listenQueue.get(null)` at module
    // scope, so the `:guest` bytes this comment says must not come back came
    // back on the very next page load. The guest bucket is cleared on disk too.
    //
    // `clear`, not `set(null, [])`. That went through `safeSet`, whose boolean
    // was DROPPED here — so on a full or blocked store the `[]` landed in the
    // memory mirror, the old bytes stayed on disk, and the guest queue came
    // back on the next load. That is precisely the failure the paragraph above
    // is about, reintroduced by the fix for it.
    setListenQueue([]);
    storage.listenQueue.clear(null);
    // Same reason as the identity-switch path: useFollows resets this when
    // identity goes null, but not until a FollowButton's effect runs.
    resetFollows();
    storage.npub.clear();
    storage.signer.clear();
    clearAmberSigner();
    // `revoke` HERE AND NOWHERE ELSE. Signing out is the one moment the user has
    // said they are done with this signer, so it is the one moment we may ask it
    // to forget us — which matters because a NIP-46 pairing lives on the
    // signer's side too, and Clave caps a user at five connections. The other
    // caller, abandonRestoredSession, deliberately does not: a restore that
    // failed on a suspended socket is not a decision to disconnect.
    clearBunkerSigner({ revoke: true });
    // Wipes the ciphertext AND the wrap key, so nothing left behind can
    // decrypt a later blob.
    clearLocalSigner().catch(() => { /* storage already gone */ });
  }

  return [signout, confirmEl];
}
