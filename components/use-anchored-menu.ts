'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMenuKeys } from './use-menu-keys';

export type MenuAt = { top?: number; bottom?: number; right: number };

/**
 * A menu opened from a trigger button and PORTALLED to `document.body` —
 * the episode page's `⋯ MORE` tile and the episode row's `⋯` on a phone.
 * One hook, so the two cannot drift in the three places they got wrong once.
 *
 * IT PORTALS, and that is not a style choice. The layout wraps {children} in
 * `relative z-0` (app/layout.tsx), which is a stacking context — so no z-index
 * inside it can rise above the root-level <TabBar> and mini-bar at z-30,
 * whatever number it carries. Rendered in place at z-40 the MORE menu opened
 * downward into the dock and its items were painted over. The caller renders
 * the menu with `createPortal(…, document.body)` at z-40: over <TabBar> and the
 * mini-bar, under <ModalShell> (z-[60]) and the iOS status strip (z-[70]).
 *
 * `at` IS MEASURED FROM THE TRIGGER each time, and again on scroll and resize:
 * a `fixed` element does not follow the page. Below the trigger when there is
 * `roomBelow` px under it, above it otherwise, and the right edge is clamped
 * BOTH WAYS. `menuWidth` is what the second clamp needs: the menu hangs to the
 * LEFT of its trigger, so a trigger that is not near the right edge — the
 * player's `⋯` sits left of the account control and ✕ — puts the panel's left
 * edge off the screen. Measured at 390px: the panel's left came out at -74.
 * The caller states the width because the panel does not exist to be measured
 * until `at` says where to put it.
 *
 * OUTSIDE-CLICK TESTS BOTH ELEMENTS, and both tests are `?.` rather than a
 * `ref.current &&` guard. A trigger may be CONDITIONALLY rendered — an episode
 * with no tracks and no `link` has no MORE tile at all — so a guard that
 * requires the ref to be live turns "the trigger went away" into "do nothing":
 * `open` stays true, the effect never re-runs its cleanup, and both document
 * listeners outlive the menu. Come back to an episode that does have the tile
 * and it is already open with no gesture.
 *
 * Keyboard (arrows, Home/End, Escape and Tab back to the trigger) is
 * `useMenuKeys`, called here so no caller can forget it.
 */
export function useAnchoredMenu({
  roomBelow = 140,
  menuWidth = 240,
}: { roomBelow?: number; menuWidth?: number } = {}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useMenuKeys({ open, menuRef, triggerRef, close });
  const [at, setAt] = useState<MenuAt | null>(null);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const right = Math.max(8, Math.min(window.innerWidth - r.right, window.innerWidth - menuWidth - 8));
    setAt(
      window.innerHeight - r.bottom >= roomBelow
        ? { top: r.bottom + 8, right }
        : { bottom: window.innerHeight - r.top + 8, right },
    );
  }, [roomBelow, menuWidth]);

  useEffect(() => {
    if (!open) return;
    place();
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  return { open, setOpen, close, triggerRef, menuRef, at };
}
