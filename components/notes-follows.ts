'use client';
import { useCallback, useRef } from 'react';
import type { NostrIdentity } from '@/lib/nostr';
import { useApp } from '@/lib/store';
import {
  ensureFollowsLoaded,
  followsSnapshot,
  refToHex,
  subscribeFollows,
  toggleFollow,
} from '@/lib/nostr/follows';

// Attaches Follow / Following buttons after each `a[data-npub]` in a show-notes
// container. The notes render via dangerouslySetInnerHTML, so React doesn't
// manage these children — we inject them imperatively (React won't clobber them
// while contentEncoded is unchanged), sync labels from the SHARED follow-state
// singleton (same one the note-card <FollowButton>s use, so following someone
// here updates there and vice versa), and tear down on episode change / sign-out.
//
// Returns a CALLBACK ref: it fires when the notes node mounts/unmounts (e.g.
// switching tabs) AND is recreated when identity/episode change, so a sign-in
// or a new episode re-runs setup on the current node.

function setup(container: HTMLElement, identity: NostrIdentity): () => void {
  const anchors = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[data-npub]'));
  if (!anchors.length) return () => {};

  let cancelled = false;
  const buttons: HTMLButtonElement[] = [];

  const paint = (btn: HTMLButtonElement) => {
    const hex = btn.dataset.hex!;
    const snap = followsSnapshot();
    const on = snap.following.has(hex);
    const busy = btn.dataset.busy === '1';
    const err = btn.dataset.err === '1';
    btn.textContent = err ? '↻ retry' : busy ? '…' : on ? '✓ Following' : '+ Follow';
    btn.className = `npub-follow-btn${on ? ' is-following' : ''}`;
    btn.disabled = busy || (!snap.ok && !err);
    btn.title = err ? 'Failed — tap to retry'
      : !snap.ok ? 'Loading your follows…'
      : on ? 'Unfollow' : 'Follow';
  };
  const paintAll = () => buttons.forEach(paint);

  for (const a of anchors) {
    const hex = refToHex(a.dataset.npub!);
    if (!hex || hex === identity.pubkey) continue; // can't follow yourself
    const sib = a.nextElementSibling as HTMLElement | null;
    if (sib?.classList?.contains('npub-follow-btn')) continue; // StrictMode double-run guard
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.hex = hex;
    a.after(btn);
    buttons.push(btn);
    paint(btn);
  }
  if (!buttons.length) return () => {};

  const toggle = async (btn: HTMLButtonElement) => {
    if (btn.dataset.busy === '1') return;
    if (!followsSnapshot().ok && btn.dataset.err !== '1') return;
    btn.dataset.busy = '1';
    btn.dataset.err = '0';
    paint(btn);
    try {
      await toggleFollow(identity, btn.dataset.hex!);
    } catch {
      if (!cancelled) btn.dataset.err = '1';
    } finally {
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

  // Repaint on any shared-state change (incl. a follow made from a note card).
  const unsub = subscribeFollows(() => { if (!cancelled) paintAll(); });
  ensureFollowsLoaded(identity); // idempotent — shared single fetch

  return () => {
    cancelled = true;
    unsub();
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
    // episodeId is deliberately a dep though unreferenced: React reuses the same
    // notes <div> across episodes (only innerHTML changes), so recreating the
    // callback is what re-fires the ref (old(null) → new(node)) and re-injects
    // buttons for the new episode's npubs. identity covers sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity, episodeId],
  );
}
