'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A value that shows for `ms` and then clears itself — the "Copied" flash.
 *
 * Returns `[value, flash, clear]`. `flash(v)` shows `v` and restarts the
 * timer; `clear()` hides it now. The timer is cleared on every flash and on
 * unmount, which is the whole reason this exists: five components hand-rolled
 * the flash, and four of them used a bare `setTimeout` that outlived the
 * component — a copy pressed just before a modal closed then set state on an
 * unmounted tree, and a second press inside the window was cut short by the
 * first press's timer. `<CopyLinkButton>` had the fix; this is that fix,
 * shared. The clipboard write itself stays in each caller, so what is copied,
 * and when, is visible at the call site.
 */
export function useFlash<T>(ms: number): [T | null, (v: T) => void, () => void] {
  const [value, setValue] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const clear = useCallback(() => {
    stop();
    setValue(null);
  }, []);

  const flash = useCallback((v: T) => {
    stop();
    setValue(v);
    timer.current = setTimeout(() => {
      timer.current = null;
      setValue(null);
    }, ms);
  }, [ms]);

  useEffect(() => stop, []);

  return [value, flash, clear];
}
