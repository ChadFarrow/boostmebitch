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
  privateHalfAlreadyOpened,
  schedulePublishMuteList,
  unionMutedPubkeys,
  type MuteListState,
} from './mutes';
import { resolvePublishRelays } from './relays';
import { listDecryptOnLoadOk, type DecryptPurpose } from './signer';
import type { NostrIdentity } from './auth';

/**
 * Reconcile local mute-list cache with the NIP-51 kind:10000 event.
 * Last-write-wins on `event.created_at` (s) vs local cache `updatedAt` (s).
 *
 * On adoption from Nostr we replace the entire local state including the
 * private list (decrypted through the user's signer, in whichever cipher the
 * wire used, when we can). When the local cache is ahead, we merge the relay's
 * other-tags into local so we don't drop hashtag/keyword mutes from another
 * client, then republish.
 *
 * `purpose` is how an explicit retry differs from a page load — the same
 * distinction `hydrateFavorites` draws. `'user-initiated'` is what
 * <MutesSyncNotice> passes, and it is the only thing that spends a signer
 * prompt on an out-of-browser signer.
 */
export async function hydrateMutes(
  identity: NostrIdentity,
  purpose: DecryptPurpose = 'unattended',
): Promise<void> {
  const { setMutedPubkeys, setMutesSync } = useApp.getState();
  // NOT ON A USER-INITIATED RETRY. `<MutesSyncNotice>` renders on
  // `mutesSync === 'degraded'`, so clearing it here unmounted the notice the
  // instant its button was pressed: `loading…` never appeared, and a retry that
  // then FAILED read as a success that undid itself a moment later. On a page
  // load this still matters — it drops a status left by the previous identity —
  // and `reportPrivateHalf` overwrites it either way before this returns.
  if (purpose !== 'user-initiated') setMutesSync('idle');
  // DO NOT SPEND AN OUT-OF-BROWSER SIGNER PROMPT HERE. This runs on every page
  // load, before the user has touched anything, and decrypting the private half
  // of the mute list is a signer call — which on Amber leaves the browser for
  // another app. Measured on a Pixel 6: the app opened, demanded
  // `nip04_decrypt`, and approving returned the user to the LAUNCHER rather
  // than to the page, so the request never resolved and the prompt came
  // straight back. That happened in an ordinary Brave tab as much as in the
  // Trusted Web Activity, so it is not a packaging problem — see
  // docs/signers.md.
  //
  // THIS USED TO SAY "AMBER ONLY", on the reasoning that a bunker answers
  // inside the browser. A bunker hosted on the user's own phone does not, and
  // Clave is one: signing in with it on iOS fired this decrypt at the phone
  // uninvited, and the answer that came back was
  // `nip04_decrypt failed: Invalid base64`. `unattendedDecryptOk` now covers
  // both; see there.
  //
  // The cost of skipping is bounded: the parked ciphertext still round-trips
  // verbatim on republish, the branch below keeps applying whatever private
  // list this device already cached, and <MutesSyncNotice> now says so on
  // screen with a control that spends the prompt on purpose.
  const decryptPrivate = purpose === 'user-initiated' || listDecryptOnLoadOk(identity.npub);
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
  const muteEvent = await fetchMutedPubkeys(identity.pubkey, relays, { decryptPrivate, purpose });

  // READ THE CACHE AFTER THE AWAIT, NEVER BEFORE IT. This used to be the first
  // line of the function, and the gap it left is not small: this hydration does
  // not start until the account's NIP-65 write set resolves (up to 4 s), then
  // spends up to another 4 s on `fetchLatestEvent`, plus a NIP-04 decrypt. So
  // the reconcile lands the better part of ten seconds into the session —
  // exactly while the user is scrolling the feed the page just painted, which
  // is when someone mutes a spam account.
  //
  // A mute made in that window was invisible here, and BOTH branches below then
  // wrote a state without it: to the store, so the note came straight back on
  // screen, and to `storage.muted`, so it did not survive the reload either.
  // The local-ahead branch went further and republished the loss, which is how
  // muting the same account over and over never took. Everything after this
  // line is synchronous, so reading here closes the window rather than
  // narrowing it.
  const cached = storage.muted.get(identity.npub);

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
        (content) => storage.muted.rememberPrivateContent(identity.npub, content),
      );
    } else {
      // Make sure the store reflects an empty state for this identity.
      setMutedPubkeys(new Set());
    }
    // No event on the relays means no private half to withhold. Not a failure.
    setMutesSync('ok');
    return;
  }

  // IS THE PARKED BLOB ONE WE HAVE ALREADY OPENED? If so it is not a withheld
  // half at all — this device holds its plaintext, so the read is as good as a
  // successful decrypt and nothing needs to be asked of the signer.
  //
  // This is what stops the notice being permanent. `unattendedDecryptOk()` is
  // false for Amber and for a bunker, and rightly so, so those signers park the
  // private half on EVERY page load. Before this, the user pressed "load", the
  // half opened, and the next load parked the identical bytes and said the half
  // stayed shut again — the button worked and could not stick.
  const reopened = privateHalfAlreadyOpened(muteEvent, cached);

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
          // DROPPING THE PARK IS THE POINT, not a tidy-up. While
          // `unreadablePrivateContent` is set the state is opaque to everything
          // downstream: `<MutesSyncNotice>` renders, and `publishMuteList`
          // round-trips the blob and ignores `privatePubkeys` entirely — so a
          // new mute on this device filters locally and never reaches a relay.
          // Clearing it on bytes we have decoded makes both behave as they would
          // have if the decrypt had just run, which is the truth of the matter.
          unreadablePrivateContent: reopened ? undefined : muteEvent.unreadablePrivateContent,
          // Carried only on a match. Otherwise another client has rewritten the
          // private half, the cached plaintext describes a document that is no
          // longer there, and the claim must not survive into the next cycle.
          knownPrivateContent: reopened ? cached.knownPrivateContent : undefined,
        }
      : muteEvent;
    storage.muted.set(identity.npub, adopted);
    setMutedPubkeys(unionMutedPubkeys(adopted));
    // REPORT ON THE RESOLVED STATE, not on the raw read. `adopted` is what the
    // app is actually working from, and it is the only one of the two that knows
    // the blob was reopened.
    reportPrivateHalf(adopted, decryptPrivate);
  } else {
    // Local is ahead. Keep our pubkeys + non-`p` tags, but adopt the relay's
    // non-`p` tags too so cross-client hashtag mutes survive.
    const merged: MuteListState = {
      publicPubkeys: cached.publicPubkeys,
      publicOtherTags: muteEvent.publicOtherTags,
      privatePubkeys: cached.privatePubkeys,
      // A reopened read carries no private tags of its own — it parked instead of
      // decoding — so taking the relay's would drop the hashtag and keyword mutes
      // sitting in the half we DO hold the plaintext of.
      privateOtherTags: reopened ? cached.privateOtherTags : muteEvent.privateOtherTags,
      unreadablePrivateContent: reopened
        ? undefined
        : cached.unreadablePrivateContent ?? muteEvent.unreadablePrivateContent,
      // The RELAY observation is the authority on what cipher the wire holds —
      // the cached one may predate a rewrite by another client. This object
      // lists every field by hand, so a new one that isn't named here is
      // dropped, and `publishMuteList` would then re-encode the list in the
      // wrong cipher on the very republish this branch is about to schedule.
      privateCipher: muteEvent.privateCipher ?? cached.privateCipher,
      // Named by hand like every other field here, and for the same reason the
      // comment above gives about `privateCipher`: one this object forgets is
      // dropped on every reload.
      knownPrivateContent: reopened ? cached.knownPrivateContent : undefined,
      updatedAt: cached.updatedAt,
    };
    storage.muted.set(identity.npub, merged);
    setMutedPubkeys(unionMutedPubkeys(merged));
    reportPrivateHalf(merged, decryptPrivate);
    schedulePublishMuteList(
      identity.pubkey,
      () => storage.muted.get(identity.npub),
      relays,
      (content) => storage.muted.rememberPrivateContent(identity.npub, content),
    );
  }
}

/**
 * Put the state of the PRIVATE half on screen, or clear it.
 *
 * Gated on `unreadablePrivateContent` on purpose: an account with no private
 * half must never see a banner, and an account whose private half we opened has
 * nothing to report. Only a half that EXISTS and stayed shut is worth a
 * sentence, because that is the case that renders as a shorter list with no
 * other symptom.
 *
 * The two reasons are not interchangeable. `decryptPrivate` false means we
 * chose not to ask — nothing is wrong and the control simply spends the prompt.
 * True means we asked and it did not open, which is worth a retry and may mean
 * this signer does not implement the cipher the list is written in.
 */
function reportPrivateHalf(read: MuteListState, decryptPrivate: boolean): void {
  const setMutesSync = useApp.getState().setMutesSync;
  if (!read.unreadablePrivateContent) {
    setMutesSync('ok');
    return;
  }
  setMutesSync('degraded', decryptPrivate ? 'private-unreadable' : 'withheld');
}

// Re-export so `lib/store.ts` can build an empty state for guest users
// without dragging in the full module.
export { emptyMuteState };
