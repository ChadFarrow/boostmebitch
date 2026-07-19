'use client';
import { useCallback, useRef } from 'react';
import type { NostrIdentity } from '@/lib/nostr';
import { useApp } from '@/lib/store';
import { fetchFollowList, publishFollow, refToHex, type FollowListState } from '@/lib/nostr/follows';

// Attaches Follow / Following buttons after each `a[data-npub]` in a show-notes
// container. The notes render via dangerouslySetInnerHTML, so React doesn't
// manage these children — we inject them imperatively (React won't clobber them
// while contentEncoded is unchanged), sync labels from the user's fetched
// kind:3 set, and tear everything down on episode change / sign-out.
//
// Returns a CALLBACK ref: it fires when the notes node mounts/unmounts (e.g.
// switching tabs) AND is recreated when identity/episode change, so a sign-in
// or a new episode re-runs setup on the current node — a plain useEffect keyed
// on a stable ref object would miss the tab remount.

function setup(container: HTMLElement, identity: NostrIdentity): () => void {
  const anchors = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[data-npub]'));
  if (!anchors.length) return () => {};

  let cancelled = false;
  let inFlight = false;
  // Fetched list; `ok` gates publishing until we have a trustworthy copy.
  let state: FollowListState = { event: null, following: new Set(), ok: false };
  const buttons: HTMLButtonElement[] = [];

  const paint = (btn: HTMLButtonElement) => {
    const hex = btn.dataset.hex!;
    const on = state.following.has(hex);
    const busy = btn.dataset.busy === '1';
    const err = btn.dataset.err === '1';
    btn.textContent = err ? '↻ retry' : busy ? '…' : on ? '✓ Following' : '+ Follow';
    btn.className = `npub-follow-btn${on ? ' is-following' : ''}`;
    btn.disabled = busy || (!state.ok && !err);
    btn.title = err ? 'Failed — tap to retry'
      : !state.ok ? 'Loading your follows…'
      : on ? 'Unfollow' : 'Follow';
  };
  const paintAll = () => buttons.forEach(paint);

  for (const a of anchors) {
    const hex = refToHex(a.dataset.npub!);
    if (!hex) continue;
    // Guard against a double-run (StrictMode) leaving two buttons.
    const sib = a.nextElementSibling as HTMLElement | null;
    if (sib?.classList?.contains('npub-follow-btn')) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.hex = hex;
    a.after(btn);
    buttons.push(btn);
    paint(btn);
  }
  if (!buttons.length) return () => {};

  const toggle = async (btn: HTMLButtonElement) => {
    if (inFlight) return;                       // serialize: each publish builds on the latest event
    const hex = btn.dataset.hex!;
    if (!state.ok && btn.dataset.err !== '1') return; // not loaded yet
    inFlight = true;
    btn.dataset.busy = '1';
    btn.dataset.err = '0';
    paint(btn);
    try {
      const wasFollowing = state.following.has(hex);
      const { event, following } = await publishFollow(identity, state.event, hex, !wasFollowing);
      if (cancelled) return;
      state = { event, following, ok: true };
    } catch {
      if (cancelled) return;
      btn.dataset.err = '1';
    } finally {
      inFlight = false;
      if (!cancelled) {
        btn.dataset.busy = '0';
        paintAll();
      }
    }
  };

  const onClick = (e: MouseEvent) => {
    const btn = (e.target as HTMLElement)?.closest?.('.npub-follow-btn') as HTMLButtonElement | null;
    if (!btn || !buttons.includes(btn)) return;
    e.preventDefault();
    void toggle(btn);
  };
  container.addEventListener('click', onClick);

  // Load the follow set, then enable the buttons.
  fetchFollowList(identity).then((s) => {
    if (cancelled) return;
    state = s;
    paintAll();
  });

  return () => {
    cancelled = true;
    container.removeEventListener('click', onClick);
    for (const b of buttons) b.remove();
  };
}

export function useNotesFollows(episodeId: number | undefined): (node: HTMLElement | null) => void {
  const identity = useApp((s) => s.identity);
  const teardown = useRef<(() => void) | null>(null);

  return useCallback(
    (node: HTMLElement | null) => {
      teardown.current?.();
      teardown.current = null;
      if (!node || !identity) return; // signed out → no buttons, njump links stay
      teardown.current = setup(node, identity);
    },
    // episodeId is deliberately a dep though unreferenced in the body: React
    // reuses the same notes <div> across episodes (only its innerHTML changes),
    // so recreating the callback is what re-fires the ref (old(null) → new(node))
    // and re-injects buttons for the new episode's npubs. identity covers sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity, episodeId],
  );
}
