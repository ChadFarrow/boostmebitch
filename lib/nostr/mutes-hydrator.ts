'use client';

// Reconcile the user's local mute-list cache with their NIP-51 kind:10000
// event on Nostr. Mirrors lib/nostr/favorites-hydrator.ts.
//
// The state here covers both public p-tags and (best-effort) NIP-04
// private p-tags — see lib/nostr/mutes.ts for the encoding details.

import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import {
  emptyMuteState,
  fetchMutedPubkeys,
  schedulePublishMuteList,
  unionMutedPubkeys,
  type MuteListState,
} from './mutes';
import { resolvePublishRelays } from './relays';
import type { NostrIdentity } from './auth';

/**
 * Reconcile local mute-list cache with the NIP-51 kind:10000 event.
 * Last-write-wins on `event.created_at` (s) vs local cache `updatedAt` (s).
 *
 * On adoption from Nostr we replace the entire local state including the
 * private list (decrypted via window.nostr.nip04 when available). When the
 * local cache is ahead, we merge the relay's other-tags into local so we
 * don't drop hashtag/keyword mutes from another client, then republish.
 */
export async function hydrateMutes(identity: NostrIdentity): Promise<void> {
  const setMutedPubkeys = useApp.getState().setMutedPubkeys;
  const cached = storage.muted.get(identity.npub);
  // DO NOT SPEND AN AMBER PROMPT HERE. This runs on every page load, before
  // the user has touched anything, and decrypting the private half of the
  // mute list is a NIP-04 call — which on Amber leaves the browser for
  // another app. Measured on a Pixel 6: the app opened, demanded
  // `nip04_decrypt`, and approving returned the user to the LAUNCHER rather
  // than to the page, so the request never resolved and the prompt came
  // straight back. That happened in an ordinary Brave tab as much as in the
  // Trusted Web Activity, so it is not a packaging problem — see
  // docs/signers.md.
  //
  // Amber only, deliberately. A NIP-07 extension and a bunker answer inside
  // the browser, and the local signer is in-process, so for them the decrypt
  // is cheap and skipping it would cost a fresh device its private mutes for
  // no benefit. The cost of skipping is bounded: the parked ciphertext still
  // round-trips verbatim on republish, and the branch below keeps applying
  // whatever private list this device already cached.
  const decryptPrivate = storage.signer.get() !== 'amber';
  // READ FROM THE RELAYS WE WRITE TO. This used to pass `undefined`, which
  // `fetchMutedPubkeys` reads as DEFAULT_RELAYS, while the republish below has
  // always targeted `resolvePublishRelays` — the user's NIP-65 write set unioned
  // with those defaults.
  //
  // The union means a defaults-only read still finds anything WE published, so
  // this matters most for the case that is normal here and not for favorites:
  // this app never CREATES a kind:10000. Damus, Amethyst and Coracle do, and
  // they publish to the user's own outbox, which need not intersect our five
  // defaults at all. A device with a local cache hides that; a fresh one reads
  // an empty mute list. Same fix, same reason, as `fetchFavoritesList` requiring
  // its relay set rather than defaulting to one.
  const relays = resolvePublishRelays(identity);
  const muteEvent = await fetchMutedPubkeys(identity.pubkey, relays, { decryptPrivate });

  if (!muteEvent) {
    // No Nostr event yet; if we have a local cache, push it up so the user's
    // first mute on a different device doesn't disappear next time we hydrate.
    const hasLocal =
      cached.publicPubkeys.length > 0 ||
      cached.privatePubkeys.length > 0 ||
      !!cached.unreadablePrivateContent;
    if (hasLocal) {
      setMutedPubkeys(unionMutedPubkeys(cached));
      schedulePublishMuteList(
        identity.pubkey,
        () => storage.muted.get(identity.npub),
        relays,
      );
    } else {
      // Make sure the store reflects an empty state for this identity.
      setMutedPubkeys(new Set());
    }
    return;
  }

  const nostrNewer = muteEvent.updatedAt >= cached.updatedAt;
  if (nostrNewer) {
    // A private section we could not read must NOT take the cached one down
    // with it. `muteEvent.privatePubkeys` is `[]` whenever the content stayed
    // encrypted — because we declined the prompt above, because the signer
    // has no NIP-04, or because the decrypt threw — and adopting that
    // wholesale silently un-mutes everyone the user muted privately, on a
    // path with no error and nothing on screen. Take the relay's public tags
    // and its (newer) ciphertext, keep this device's decoded private entries
    // for filtering. Nothing is lost on republish either: publishMuteList
    // passes `unreadablePrivateContent` through verbatim and ignores
    // `privatePubkeys` when it is set.
    const adopted: MuteListState = muteEvent.unreadablePrivateContent
      ? {
          ...muteEvent,
          privatePubkeys: cached.privatePubkeys,
          privateOtherTags: cached.privateOtherTags,
        }
      : muteEvent;
    storage.muted.set(identity.npub, adopted);
    setMutedPubkeys(unionMutedPubkeys(adopted));
  } else {
    // Local is ahead. Keep our pubkeys + non-`p` tags, but adopt the relay's
    // non-`p` tags too so cross-client hashtag mutes survive.
    const merged: MuteListState = {
      publicPubkeys: cached.publicPubkeys,
      publicOtherTags: muteEvent.publicOtherTags,
      privatePubkeys: cached.privatePubkeys,
      privateOtherTags: muteEvent.privateOtherTags,
      unreadablePrivateContent: cached.unreadablePrivateContent ?? muteEvent.unreadablePrivateContent,
      updatedAt: cached.updatedAt,
    };
    storage.muted.set(identity.npub, merged);
    setMutedPubkeys(unionMutedPubkeys(merged));
    schedulePublishMuteList(
      identity.pubkey,
      () => storage.muted.get(identity.npub),
      relays,
    );
  }
}

// Re-export so `lib/store.ts` can build an empty state for guest users
// without dragging in the full module.
export { emptyMuteState };
