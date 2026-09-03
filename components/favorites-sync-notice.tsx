'use client';
import { useState } from 'react';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { hydrateFavorites, syncFavoritesNow } from '@/lib/nostr';
import { resetPiBreaker } from '@/lib/podcast-meta';

// "We couldn't reach the relays" made visible.
//
// `hydrateFavorites` keeps local favorites and publishes nothing when the read
// comes back untrustworthy — the most important safety property in the feature,
// because the naive alternative treats "nothing answered" as "the list is
// empty" and republishes that over the user's whole library, in every app that
// reads the shared list, with no undo. The guard is right; it was just silent.
//
// Silent is expensive here. A degraded read and a genuinely empty list render
// identically, so on a device with no cache — a new browser, a private tab, a
// second device — the correct guard looks exactly like data loss. It cost half
// an hour of production debugging and nearly a revert of the address gate that
// would have re-exposed every user to the shared list.
//
// The DEFAULT wording names the CONSEQUENCE, not one cause, because two of the
// causes are indistinguishable from here. A degraded read is one: nothing
// answered. The other is a merge that came out empty over a list that is not —
// `planFavoritesPublish`'s `wholesale-delete`, or the same shape caught against
// this device's own cache — where the relays answered fine and the answer is
// still one we refuse to adopt. "Couldn't reach the relays" would be a lie in
// the second case, and the user's action is identical in both: retry, and until
// then trust what is on screen.
//
// THE PRIVATE HALF BREAKS THAT TIE, and gets its own sentence. A list this
// signer cannot decrypt renders exactly like a shorter list — so the user
// cannot tell "hidden here by choice" from "this app has not been able to open
// it", and the retry means something different: it is the one place an Amber
// user can spend a decrypt prompt on purpose, because the cold start
// deliberately never asks. `favoritesSyncReason` carries which case it is.
//
// The size refusal is separate again, and is the one case where retrying is
// NOT the answer — nothing about the relays or the signer will change, and
// telling someone to retry a thing that cannot succeed is worse than saying
// nothing.
//
// Signed out is deliberately not a case this handles: favorites are local by
// design with no key to sync them under, so there is no relay failure to
// report and claiming one would be a lie.
//
// ONE flag, where there used to be one per list. Shows and episodes live in a
// single kind:10333 event now, so they cannot fail independently and the notice
// has nothing to disambiguate — the old three-branch message existed only
// because a successful read of one address had to be prevented from clearing a
// notice the other's failure had raised.

export function FavoritesSyncNotice() {
  const identity = useApp((s) => s.identity);
  const degraded = useApp((s) => s.favoritesSync === 'degraded');
  const reason = useApp((s) => s.favoritesSyncReason);
  const [retrying, setRetrying] = useState(false);

  // 'idle' is NOT a failure — it is the pre-hydration and signed-out state, and
  // treating it as one would show a relay warning to every visitor before
  // anything had even been attempted.
  if (!identity || !degraded) return null;

  // Two reasons, one control. 'private-withheld' is the hydrator saying it did
  // not ASK — the signer lives outside the browser and would have shown the
  // plaintext, or prompted, on a page load nobody was watching. It is a choice,
  // so it gets no ⚠ and no "couldn't": an Amber user sees this on every cold
  // start, and it read as a fault. 'private-unreadable' is the decrypt that ran
  // and failed, which IS worth the warning glyph. Both offer the same unlock.
  const privateWithheld = reason === 'private-withheld';
  const privateUnreadable = reason === 'private-unreadable' || privateWithheld;
  const tooLarge = reason === 'private-too-large';
  const ambiguous = reason === 'mode-ambiguous';

  const message = privateWithheld
    ? "Your private favorites weren't opened on load — showing what's saved on this device."
    : privateUnreadable
    ? "⚠ Your signer couldn't open the private half of your list — showing what's on this device."
    : tooLarge
      ? '⚠ Your private favorites are too large to store safely. Nothing was changed; make some public to fit.'
      : ambiguous
        // The withholding this names is real and would otherwise be invisible:
        // both halves hold entries, so this device cannot tell which one it
        // owns, and it renders the public half alone rather than guess. A
        // shorter list with an 'ok' status is indistinguishable from a bug.
        ? '⚠ Your list has both a public and a private half, so this device can\u2019t tell which is yours. Showing the public half only — choose one in favorites settings.'
        : "⚠ Couldn't confirm your list — showing what's on this device.";

  async function retry() {
    setRetrying(true);
    try {
      // "Retry" has to mean everything, not just the relay half. The PI
      // circuit breaker lives in sessionStorage, so it survives reloads for
      // the life of the tab: a combined outage that trips it leaves show
      // metadata resolving from cache while every episode short-circuits to
      // null with no fetch, and no amount of reloading recovers. This is the
      // explicit user retry `resetPiBreaker` was written for — it had no
      // caller until now.
      resetPiBreaker();
      // Record the consent BEFORE the pass that spends it, and only on the
      // unlock path. `privateUnreadable` is true for both withheld and
      // genuinely-unreadable, which is right: in either case the user has just
      // said "open these", and the flag only ever removes a question they have
      // now answered. A plain relay 'retry' writes nothing — it is not about
      // decryption at all.
      //
      // Before, not after, because a success unmounts this component: the
      // hydrator flips `favoritesSync` and the notice goes away mid-await, so
      // anything written afterwards races an unmount for no benefit.
      if (privateUnreadable) storage.listUnlock.set(identity!.npub, true);
      // Single-flight inside the hydrator, so a double-tap joins the first run
      // rather than starting a second read-merge-publish cycle. A success
      // flips `favoritesSync` and unmounts this component from under us.
      // On the unlock path this pass is itself user-initiated, which is what
      // makes it PAINT. Publishing without repainting was the bug: `syncFavorites`
      // never touches the store, so a successful unlock cleared the notice and
      // left the entries it had just unlocked off the screen — the explanation
      // gone and nothing in its place.
      await hydrateFavorites(identity!, privateUnreadable ? 'user-initiated' : 'unattended');
      // Then publish, so the merge this device now understands goes back up.
      // Second, not first: a publish that precedes the paint cannot fix the
      // screen, and the hydrator is what owns the store.
      if (privateUnreadable) await syncFavoritesNow(identity!, 'user-initiated');
    } catch {
      // The hydrator already set 'degraded'; the notice simply stays up.
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div
      role="status"
      className="text-[11px] text-nostr/80 border border-nostr/30 bg-nostr/5 px-2 py-1.5 mb-2 flex items-center justify-between gap-2"
    >
      <span>{message}</span>
      {!tooLarge && !ambiguous && (
        <button
          type="button"
          onClick={retry}
          disabled={retrying}
          className="underline underline-offset-2 hover:text-nostr disabled:opacity-40 flex-shrink-0"
        >
          {retrying ? 'retrying…' : privateUnreadable ? 'unlock' : 'retry'}
        </button>
      )}
    </div>
  );
}
