'use client';

import { useEffect, useRef } from 'react';
import { centerInScrollBox, scrollBehavior } from '@/lib/format';

/**
 * Keeps the PLAYING row of a now-playing track list in view: the shuffle list
 * and the album panel, each a `max-h-80` box of its own.
 *
 * **Asked for on 2026-11-14, over two screenshots of a 230-track favorites
 * shuffle** (Chad, desktop, beta): the row for "Holy Water" was highlighted,
 * but it was row 12, and the list opened at row 1, so finding it took a manual
 * scroll — *"it is highlighted it just doesnt auto scroll"*.
 *
 * Returns the ref for the list's scroll box. The row is found by
 * `[aria-current="true"]` inside it, so the list keeps ONE marker for "this is
 * playing" — the one a screen reader already reads — and no ref per row.
 *
 * - **It follows `activeIndex`, never a render.** A list that re-renders under
 *   the listener (a late shuffle track joining AFTER the playing one, the
 *   splits row loading above) must not pull the list back while they read it.
 *   A row moves only when the playing row does.
 * - **It scrolls only while the sheet is open.** `<FullscreenPlayer>` stays
 *   mounted while closed (`invisible`, slid down), so a track change there
 *   scrolls nothing, and the OPEN does the catching up. The caller passes
 *   "open AND the lists are mounted" (`open && everOpened`): on a page's first
 *   open the subtree mounts one commit after `open` turns true.
 * - **The first scroll for a box is instant; later ones animate.** The sheet
 *   slides up for 300 ms as it opens, and a list animating inside a moving
 *   sheet is two motions at once. Each later step animates through
 *   `scrollBehavior()`, so a reduced-motion setting gets a jump.
 * - **Only the box scrolls** (`centerInScrollBox`). `scrollIntoView` would also
 *   scroll the sheet on a phone, where this list is one part of a page the
 *   listener scrolls themselves.
 */
export function useFollowActiveRow<T extends HTMLElement>(open: boolean, activeIndex: number) {
  const boxRef = useRef<T | null>(null);
  // The box this hook last scrolled while the sheet was open. A different box
  // (the panel remounted) or a fresh open gets the instant first scroll.
  const followed = useRef<T | null>(null);

  useEffect(() => {
    if (!open) {
      followed.current = null;
      return;
    }
    const box = boxRef.current;
    if (!box || activeIndex < 0) return;
    const row = box.querySelector<HTMLElement>('[aria-current="true"]');
    if (!row) return;
    const first = followed.current !== box;
    followed.current = box;
    centerInScrollBox(box, row, first ? 'auto' : scrollBehavior());
  }, [open, activeIndex]);

  return boxRef;
}
