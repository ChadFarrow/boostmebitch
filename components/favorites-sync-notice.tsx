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
// There are TWO lists and therefore two flags, and it must be able to say that
// only part of what you are looking at failed to load. One flag across both
// would be worse than none: a successful shows read would clear the notice a
// failed tracks read set, handing the user a clean, confident empty state for
// their entire track library.

export function FavoritesSyncNotice() {
  const identity = useApp((s) => s.identity);
  const feeds = useApp((s) => s.favoritesSync.feeds);
  const items = useApp((s) => s.favoritesSync.items);
  const [retrying, setRetrying] = useState(false);

  // 'idle' is NOT a failure. Accounts on the legacy single-list address have no
  // items list at all, so `items` sits at 'idle' forever — and that is everyone
  // not on the trial allowlist, so treating it as degraded would show a
  // permanent false alarm to the entire user base.
  const message =
    feeds === 'degraded' && items === 'degraded'
      ? "Couldn't reach the relays — showing what's on this device."
      : feeds === 'degraded'
        ? "Couldn't load your saved shows — showing what's on this device."
        : items === 'degraded'
          ? "Couldn't load your saved episodes — showing what's on this device."
          : null;

  if (!identity || !message) return null;

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
      <span>⚠ {message}</span>
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
