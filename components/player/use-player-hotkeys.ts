'use client';
import { useEffect } from 'react';
import { raisesKeyboard } from '@/lib/keyboard-inset';

/**
 * Keyboard transport for the player, document-wide: Space and `k` toggle
 * play, ← / `j` skip back 15 s, → / `l` skip forward 30 s — the keys every
 * video site has trained people on, and the thing a media player on a laptop
 * is missing until it has them.
 *
 * Mounted once, by <Player> in the root layout, so it works on every route.
 * The whole difficulty is knowing when NOT to fire, and each guard below is a
 * real way to break something:
 *
 *   - typing: any element that raises a keyboard (`raisesKeyboard`, the same
 *     predicate the dock uses) — Space in the search box is a space;
 *   - a focused control: a button, link, menu item, select or range input
 *     already uses Space/Enter/arrows for its own activation and a seek
 *     slider uses the arrows to scrub, so those keep their meaning;
 *   - an open dialog (`[role="dialog"]`): its focus trap owns the keyboard;
 *   - a modifier held: ⌘←, Ctrl+Space and friends are the browser's;
 *   - nothing loaded: with no `current` there is nothing to toggle.
 *
 * `preventDefault` ONLY on a key this handles, and only then: Space would
 * otherwise scroll the page, and a swallowed unhandled key is how a shortcut
 * layer breaks find-in-page.
 */
const SKIP_BACK_SEC = 15;
const SKIP_FORWARD_SEC = 30;

/** True when the element that has focus owns the keyboard for itself. */
export function focusOwnsKeys(el: Element | null): boolean {
  if (!el || el === document.body) return false;
  if (raisesKeyboard(el)) return true;
  if (el.closest('[role="dialog"]')) return true;
  if (el instanceof HTMLInputElement) return true; // range, checkbox, radio — all key-driven
  if (el instanceof HTMLSelectElement || el instanceof HTMLButtonElement) return true;
  if (el instanceof HTMLAnchorElement && el.hasAttribute('href')) return true;
  const role = el.getAttribute('role') ?? '';
  return role === 'button' || role === 'switch' || role === 'tab' || role.startsWith('menuitem') || role === 'slider';
}

export function usePlayerHotkeys({
  enabled,
  togglePlay,
  skipBy,
}: {
  enabled: boolean;
  togglePlay: () => void;
  skipBy: (deltaSec: number) => void;
}): void {
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (focusOwnsKeys(document.activeElement)) return;
      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
        case 'j':
        case 'J':
          e.preventDefault();
          skipBy(-SKIP_BACK_SEC);
          break;
        case 'ArrowRight':
        case 'l':
        case 'L':
          e.preventDefault();
          skipBy(SKIP_FORWARD_SEC);
          break;
        default:
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled, togglePlay, skipBy]);
}
