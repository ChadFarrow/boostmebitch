'use client';
import { useEffect, useRef, useState } from 'react';
import type { Podcast } from '@/lib/types';

interface Props {
  /** Both callbacks are effect dependencies — pass referentially stable
   *  functions (useCallback / state setters) or the debounce restarts on
   *  every parent render and the empty-query reset loops. */
  onResults: (feeds: Podcast[], q: string) => void;
  onLoading: (b: boolean) => void;
  /**
   * Fired synchronously on every edit of the query, before any fetch is queued.
   *
   * Exists so a consumer can react to the USER searching rather than to results
   * ARRIVING. Those are not the same moment, and a view change driven by the
   * second one races: a response for a query the user has since abandoned lands
   * after they've navigated away and moves the page under them. Not an effect
   * dependency, so it doesn't have to be referentially stable.
   */
  onQueryChange?: (q: string) => void;
}

export function SearchBar({ onResults, onLoading, onQueryChange }: Props) {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Every edit goes through here — the input and the clear button both — so the
  // "user is searching" signal can't be attached to one and forgotten on the
  // other. Deliberately not an effect: the point is that it fires on the
  // gesture, ahead of the debounce and the fetch.
  function edit(next: string) {
    setQ(next);
    onQueryChange?.(next);
  }

  // Focus on mount only for fine-pointer (mouse) devices. On touch devices
  // autofocus pops the keyboard and scrolls the viewport to the input — and
  // since goHome() remounts the bar via searchKey, tapping the header title
  // on mobile jumped to the search box instead of just showing home.
  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) inputRef.current?.focus();
  }, []);

  // Generation counter, because `clearTimeout` only cancels a request that
  // hasn't STARTED. Once one is in flight the cleanup can't reach it, so a slow
  // response for "bow" could land after a fast one for "bowl after bowl" and
  // replace the results the user is looking at with the ones they'd moved past.
  const genRef = useRef(0);

  useEffect(() => {
    if (!q.trim()) { onResults([], ''); return; }
    const gen = ++genRef.current;
    const t = setTimeout(async () => {
      onLoading(true);
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = await r.json();
        if (gen !== genRef.current) return;
        onResults(Array.isArray(data?.feeds) ? data.feeds : [], q);
      } catch {
        // try/finally with no catch made a dropped connection or a non-JSON
        // body an unhandled rejection. An empty result set is the honest answer
        // here — the surrounding UI already renders "no results" — and the next
        // keystroke retries anyway.
        if (gen === genRef.current) onResults([], q);
      } finally {
        if (gen === genRef.current) onLoading(false);
      }
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
        onChange={(e) => edit(e.target.value)}
        placeholder="search podcasts… (try ‘bowl after bowl’)"
      />
      {q && (
        <button
          type="button"
          onClick={() => edit('')}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded-full text-muted hover:bg-line hover:text-bone"
        >
          ×
        </button>
      )}
    </div>
  );
}
