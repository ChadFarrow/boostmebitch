'use client';
import { useEffect, useReducer, useState } from 'react';
import { useApp } from '@/lib/store';
import { bunkerRequestTooLarge } from '@/lib/nostr';
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
  // NOT A BOOLEAN, and the reason is the one failure a retry cannot clear. A
  // follow list past NIP-46's request ceiling can never be signed by a remote
  // signer — no reconnect, no re-pairing and no number of taps changes it — so
  // `↻ retry` there is an instruction that cannot be carried out, offered in
  // place of the one fact the user needs. `terminal` is what stops the button
  // asking for a tap it knows will fail. See lib/nostr/nip46-errors.ts.
  const [failure, setFailure] = useState<{ text: string; terminal: boolean } | null>(null);

  if (!identity || identity.pubkey === pubkey) return null;

  const on = following.has(pubkey);
  // The list fetch itself failed (degraded relays) — distinct from a failed
  // toggle. Offer retry rather than sitting disabled on a misleading "loading".
  const fetchFailed = !ok && !loading;
  const retry = (failure !== null && !failure.terminal) || fetchFailed;
  const stuck = failure?.terminal === true;

  async function onClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy || loading || stuck) return;
    if (fetchFailed) {
      // Re-run the one-time load (loadedFor is null after a degraded fetch, so
      // this actually re-queries instead of no-oping).
      ensureFollowsLoaded(identity!);
      return;
    }
    if (!ok) return;
    setBusy(true);
    setFailure(null);
    try {
      await toggleFollow(identity!, pubkey);
    } catch (e2) {
      setFailure(
        bunkerRequestTooLarge(e2)
          ? {
            // THE COUNT IS IN IT because the limit is a count, and the number
            // the user can see elsewhere is the only way to tell this apart
            // from the vague failures that do deserve a retry. The remedy named
            // is the honest one: nothing on this device can make a 65,535-byte
            // NIP-46 request fit.
            text: `Your follow list (${following.size} accounts) is too large for a remote signer`
              + ' to sign — one NIP-46 request holds at most 64 KB. Change who you follow in an'
              + ' app that holds your key itself.',
            terminal: true,
          }
          : { text: 'Follow failed — tap to retry.', terminal: false },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={busy || loading || stuck}
        aria-pressed={on}
        className={`npub-follow-btn${on ? ' is-following' : ''} ${className}`}
        title={
          failure
            ? failure.text
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
      {/* ITS OWN LINE, via `basis-full` in the wrapping flex row this button
          sits in. A `title` is the only thing that carried this before and a
          hover tooltip is not reachable on the phone the whole report came
          from — a disabled control with no visible reason is the shape
          CLAUDE.md calls indistinguishable from a broken one. */}
      {failure && (
        <span className="basis-full text-[10px] text-nostr/80 leading-snug">{failure.text}</span>
      )}
    </>
  );
}
