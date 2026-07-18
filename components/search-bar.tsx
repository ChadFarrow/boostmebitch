'use client';
import { useEffect, useRef, useState } from 'react';
import type { Podcast } from '@/lib/types';

interface Props {
  /** Both callbacks are effect dependencies — pass referentially stable
   *  functions (useCallback / state setters) or the debounce restarts on
   *  every parent render and the empty-query reset loops. */
  onResults: (feeds: Podcast[], q: string) => void;
  onLoading: (b: boolean) => void;
}

export function SearchBar({ onResults, onLoading }: Props) {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus on mount only for fine-pointer (mouse) devices. On touch devices
  // autofocus pops the keyboard and scrolls the viewport to the input — and
  // since goHome() remounts the bar via searchKey, tapping the header title
  // on mobile jumped to the search box instead of just showing home.
  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!q.trim()) { onResults([], ''); return; }
    const t = setTimeout(async () => {
      onLoading(true);
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = await r.json();
        onResults(data.feeds ?? [], q);
      } finally { onLoading(false); }
    }, 280);
    return () => clearTimeout(t);
  }, [q, onResults, onLoading]);

  return (
    <div className="relative">
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-xs">⌕</span>
      <input
        ref={inputRef}
        className="input pl-8 pr-8"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="search podcasts… (try ‘bowl after bowl’)"
      />
      {q && (
        <button
          type="button"
          onClick={() => setQ('')}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded-full text-muted hover:bg-line hover:text-bone"
        >
          ×
        </button>
      )}
    </div>
  );
}
