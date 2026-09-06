'use client';
import { useEffect, type RefObject } from 'react';

/**
 * Keyboard support for a `role="menu"` this app opens from a trigger button:
 * the search-type / favorites-filter `<SelectMenu>`, the sign-in dropdown, the
 * account menu and the episode page's `⋯ MORE` menu.
 *
 * Each of those opened a menu and left focus on the trigger BEHIND it (or, for
 * the portalled ones, behind a layer on top of it), handled Escape only, and
 * on select unmounted the menu with focus falling to `<body>`. A `role="menu"`
 * is a promise of the menu pattern — arrow keys move, Home/End jump, Escape
 * closes and returns focus — and a screen-reader user is told "menu" and then
 * finds the arrows inert. One hook, four sites, so the four cannot drift.
 *
 * What it does while `open`:
 *   - moves focus onto the checked item, else the first enabled one;
 *   - ArrowDown/ArrowUp cycle, Home/End jump, all skipping disabled items;
 *   - Escape and Tab close (the caller's `close`), and focus goes back to the
 *     trigger — but ONLY when focus was inside the menu or on `<body>`. An
 *     outside click that landed on some other control keeps that control.
 *
 * Items are whatever the menu holds that is focusable: `[role^="menuitem"]`,
 * `button` and `a[href]`, because the account menu's rows are plain buttons.
 * Selection itself stays the item's own `onClick`; Enter and Space already
 * activate a focused button, so nothing is re-implemented here.
 */
const ITEM_SELECTOR = '[role^="menuitem"]:not([disabled]), button:not([disabled]), a[href]';

export function useMenuKeys({
  open,
  menuRef,
  triggerRef,
  close,
}: {
  open: boolean;
  menuRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLElement | null>;
  close: () => void;
}): void {
  useEffect(() => {
    if (!open) return;
    // Captured now: by the time the cleanup runs the ref may point elsewhere.
    const trigger = triggerRef.current;
    const items = (): HTMLElement[] =>
      Array.from(menuRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);

    // Initial focus: the checked item (a radio menu remembers its choice) else
    // the first. `preventScroll` so a `fixed` portalled menu does not yank the
    // page under it. The menu may mount a frame AFTER `open` flips — the
    // portalled ones measure the trigger in an effect and render once they
    // have a position — so this waits for the element rather than assuming it.
    let raf = 0;
    let tries = 0;
    const focusInitial = () => {
      const list = items();
      if (!list.length) {
        if (tries++ < 10) raf = requestAnimationFrame(focusInitial);
        return;
      }
      const checked = list.find((el) => el.getAttribute('aria-checked') === 'true');
      (checked ?? list[0])?.focus({ preventScroll: true });
    };
    focusInitial();

    function onKey(e: KeyboardEvent) {
      const list = items();
      if (!list.length) return;
      const at = list.indexOf(document.activeElement as HTMLElement);
      const go = (i: number) => {
        e.preventDefault();
        list[(i + list.length) % list.length]?.focus({ preventScroll: true });
      };
      switch (e.key) {
        case 'ArrowDown': go(at + 1); break;
        case 'ArrowUp': go(at - 1); break;
        case 'Home': go(0); break;
        case 'End': go(list.length - 1); break;
        case 'Escape':
          e.preventDefault();
          close();
          break;
        case 'Tab':
          // Tabbing out of a menu closes it; the browser moves focus itself.
          close();
          break;
        default:
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      // Runs on close (and on unmount). Return focus to the trigger only when
      // nothing else took it — the menu's own item (possibly already detached
      // from the document), or the body after the menu unmounted from under
      // the focused element.
      const active = document.activeElement;
      const orphaned =
        !active || active === document.body || !document.contains(active) || !!active.closest('[role="menu"]');
      if (orphaned) trigger?.focus({ preventScroll: true });
    };
  }, [open, menuRef, triggerRef, close]);
}
