'use client';
import { useState } from 'react';
import { useApp } from '@/lib/store';
import { hydrateFavorites } from '@/lib/nostr';
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
  const [retrying, setRetrying] = useState(false);

  // 'idle' is NOT a failure — it is the pre-hydration and signed-out state, and
  // treating it as one would show a relay warning to every visitor before
  // anything had even been attempted.
  if (!identity || !degraded) return null;

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
      // Single-flight inside the hydrator, so a double-tap joins the first run
      // rather than starting a second read-merge-publish cycle. A success
      // flips `favoritesSync` and unmounts this component from under us.
      await hydrateFavorites(identity!);
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
      <span>⚠ Couldn&apos;t reach the relays — showing what&apos;s on this device.</span>
      <button
        type="button"
        onClick={retry}
        disabled={retrying}
        className="underline underline-offset-2 hover:text-nostr disabled:opacity-40 flex-shrink-0"
      >
        {retrying ? 'retrying…' : 'retry'}
      </button>
    </div>
  );
}
