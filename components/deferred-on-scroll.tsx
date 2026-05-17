'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Lazy-mount wrapper for below-the-fold sections whose initial fetches would
 * otherwise contend with media playback / primary content load. The observer
 * is attached inside requestIdleCallback (fallback 500ms timeout) so podcast
 * info + audio buffering get a clean cold-load window even if the deferred
 * section happens to be in view at mount.
 */
export function DeferredOnScroll({
  rootMargin = '200px',
  placeholder,
  children,
}: {
  rootMargin?: string;
  placeholder?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shouldRender, setShouldRender] = useState(false);

  useEffect(() => {
    if (shouldRender) return;
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShouldRender(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShouldRender(true);
          obs.disconnect();
        }
      },
      { rootMargin },
    );
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let idleId: number | null = null;
    let timeoutId: number | null = null;
    let cancelled = false;
    const attach = () => {
      if (cancelled) return;
      obs.observe(node);
    };
    if (win.requestIdleCallback) {
      idleId = win.requestIdleCallback(attach, { timeout: 1500 });
    } else {
      timeoutId = window.setTimeout(attach, 500);
    }
    return () => {
      cancelled = true;
      if (idleId !== null && win.cancelIdleCallback) win.cancelIdleCallback(idleId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      obs.disconnect();
    };
  }, [shouldRender, rootMargin]);

  return <div ref={ref}>{shouldRender ? children : placeholder ?? null}</div>;
}
