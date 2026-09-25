'use client';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredMenu } from '../use-anchored-menu';

/**
 * A `.tile` that opens a small menu of choices — how the now-playing screen's
 * desktop row holds SHARE (two targets) and SPEED (seven rates) in one tile
 * each, where the phone's ⋯ menu spends a tile per choice.
 *
 * Portalled at z-[55], the ⋯ menu's own layer: over <FullscreenPlayer> (z-50),
 * under <ModalShell> (z-[60]). Placement, outside-click and the keyboard are
 * `useAnchoredMenu`'s, so this adds no second copy of any of them.
 *
 * `children` receives `close`, because the two callers differ: a speed closes
 * the menu on the press, while a copied link keeps it open so its COPIED flash
 * is the answer.
 */
export function TileMenu({
  label,
  trigger,
  menuWidth,
  lit = false,
  columns = 1,
  children,
}: {
  /** Accessible name of the trigger and the menu. */
  label: string;
  /** The tile's face: a glyph over a word, as every `.tile` draws it. */
  trigger: ReactNode;
  menuWidth: number;
  lit?: boolean;
  columns?: number;
  children: (close: () => void) => ReactNode;
}) {
  const menu = useAnchoredMenu({ roomBelow: 240, menuWidth });
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        onClick={() => menu.setOpen((v) => !v)}
        className={`tile ${lit || menu.open ? 'border-bolt text-bolt' : ''}`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-label={label}
        title={label}
      >
        {trigger}
      </button>
      {menu.open && menu.at && createPortal(
        <div
          ref={menu.menuRef}
          role="menu"
          aria-label={label}
          className="fixed card bg-ink p-2 z-[55] shadow-xl grid gap-2"
          style={{
            width: menuWidth,
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            top: menu.at.top,
            bottom: menu.at.bottom,
            right: menu.at.right,
          }}
        >
          {children(menu.close)}
        </div>,
        document.body,
      )}
    </>
  );
}
