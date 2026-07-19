'use client';
import { useEffect, useReducer, useState } from 'react';
import { useApp } from '@/lib/store';
import {
  subscribeFollows,
  followsSnapshot,
  ensureFollowsLoaded,
  resetFollows,
  toggleFollow,
  type FollowsSnapshot,
} from '@/lib/nostr/follows';

// Subscribes to the shared follow-state singleton and kicks off the one-time
// load for the signed-in user. Every FollowButton shares one kind:3 fetch.
export function useFollows(): FollowsSnapshot {
  const identity = useApp((s) => s.identity);
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    const unsub = subscribeFollows(force);
    if (identity) ensureFollowsLoaded(identity); // idempotent — one fetch total
    else resetFollows();
    return unsub;
  }, [identity]);
  return followsSnapshot();
}

// Inline Follow / Following toggle for a Nostr author. Hidden when signed out or
// on the viewer's own note (can't follow yourself). Disabled until the follow
// list loads (so a toggle never publishes from an unfetched list); a failed
// publish flips to a retry state.
export function FollowButton({ pubkey, className = '' }: { pubkey: string; className?: string }) {
  const identity = useApp((s) => s.identity);
  const { following, ok, loading } = useFollows();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  if (!identity || identity.pubkey === pubkey) return null;

  const on = following.has(pubkey);
  // The list fetch itself failed (degraded relays) — distinct from a failed
  // toggle. Offer retry rather than sitting disabled on a misleading "loading".
  const fetchFailed = !ok && !loading;
  const retry = err || fetchFailed;

  async function onClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy || loading) return;
    if (fetchFailed) {
      // Re-run the one-time load (loadedFor is null after a degraded fetch, so
      // this actually re-queries instead of no-oping).
      ensureFollowsLoaded(identity!);
      return;
    }
    if (!ok) return;
    setBusy(true);
    setErr(false);
    try {
      await toggleFollow(identity!, pubkey);
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || loading}
      className={`npub-follow-btn${on ? ' is-following' : ''} ${className}`}
      title={
        err
          ? 'Failed — tap to retry'
          : fetchFailed
            ? "Couldn't load your follows — tap to retry"
            : loading
              ? 'Loading your follows…'
              : on
                ? 'Unfollow'
                : 'Follow'
      }
    >
      {retry ? '↻ retry' : busy || loading ? '…' : on ? '✓ Following' : '+ Follow'}
    </button>
  );
}
