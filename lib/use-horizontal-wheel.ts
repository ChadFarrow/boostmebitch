'use client';
import { useEffect, type RefObject } from 'react';

/**
 * Translate vertical mouse-wheel into horizontal scroll over a card row.
 *
 * React's `onWheel` is passive (can't `preventDefault`), so the listener is
 * attached natively. We only hijack the gesture when there's horizontal
 * overflow, the gesture is vertical (mouse wheel, not a trackpad swipe), and
 * the row isn't already at the edge in that direction — so page scroll still
 * takes over once you reach the end.
 *
 * Shared by the "Live on Nostr" and podroll rows. No dep array: the handler
 * reads the element's scroll geometry live on every event, so it never needs
 * re-attaching when the row's contents change.
 */
export function useHorizontalWheelScroll(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const atStart = el.scrollLeft <= 0;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
      if ((e.deltaY < 0 && atStart) || (e.deltaY > 0 && atEnd)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref]);
}
