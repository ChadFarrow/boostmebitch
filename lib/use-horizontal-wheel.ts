'use client';
import { useCallback, useRef } from 'react';

/**
 * Translate vertical mouse-wheel into horizontal scroll over a card row.
 *
 * React's `onWheel` is passive (can't `preventDefault`), so the listener is
 * attached natively. We only hijack the gesture when there's horizontal
 * overflow, the gesture is vertical (mouse wheel, not a trackpad swipe), and
 * the row isn't already at the edge in that direction — so page scroll still
 * takes over once you reach the end.
 *
 * Returns a **callback ref**, not a ref object — spread it onto the scrolling
 * element: `const rowRef = useHorizontalWheelScroll<HTMLDivElement>()` then
 * `<div ref={rowRef}>`. This is load-bearing: both consumers render a skeleton
 * (with no ref on it) until their data resolves, so at first paint the real row
 * doesn't exist yet. A `useEffect` reading `ref.current` would see null, bail,
 * and — with a stable dep — never re-run once the row finally mounted, leaving
 * the wheel dead. A callback ref fires exactly when the node mounts and again
 * with null when it unmounts, so the skeleton -> row swap attaches correctly
 * with no dependency to get wrong.
 */
export function useHorizontalWheelScroll<T extends HTMLElement>() {
  const detach = useRef<(() => void) | null>(null);

  return useCallback((el: T | null) => {
    // Drop the previous node's listener (row swap, or unmount when el is null).
    detach.current?.();
    detach.current = null;
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
    detach.current = () => el.removeEventListener('wheel', onWheel);
  }, []);
}
