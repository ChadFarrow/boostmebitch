'use client';
import { useEffect, useState } from 'react';
import type { Podcast } from '@/lib/types';

interface Props {
  onResults: (feeds: Podcast[], q: string) => void;
  onLoading: (b: boolean) => void;
}

export function SearchBar({ onResults, onLoading }: Props) {
  const [q, setQ] = useState('');

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
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative">
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-xs">⌕</span>
      <input
        autoFocus
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
