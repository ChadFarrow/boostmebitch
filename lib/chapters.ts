'use client';
import { useEffect, useState } from 'react';

export interface ChapterEntry {
  startTime: number;
  title?: string;
}

/** Fetch and parse a Podcasting 2.0 chapters JSON file. Re-fetches when `url` changes. */
export function useChapters(url: string): { chapters: ChapterEntry[] | null; loading: boolean } {
  const [chapters, setChapters] = useState<ChapterEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setChapters(null);
    // Proxy through our own route: many chapter hosts (e.g. Fountain) serve the
    // JSON without CORS headers, so a direct browser fetch is blocked.
    fetch(`/api/chapters?url=${encodeURIComponent(url)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const list: ChapterEntry[] = Array.isArray(data?.chapters)
          ? data.chapters.map((c: { startTime?: unknown; title?: unknown }) => ({
              startTime: Number(c.startTime) || 0,
              title: typeof c.title === 'string' ? c.title : undefined,
            }))
          : [];
        setChapters(list);
      })
      .catch(() => { if (!cancelled) setChapters([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [url]);

  return { chapters, loading };
}
