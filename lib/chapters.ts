'use client';
import { useEffect, useState } from 'react';
import { isMusicMedium } from './util';
import type { Episode, Podcast } from './types';

export interface ChapterEntry {
  startTime: number;
  title?: string;
  img?: string;   // per-chapter artwork (Podcasting 2.0 chapters `img`)
  url?: string;   // per-chapter external link (chapters `url`)
}

/** Fetch and parse a Podcasting 2.0 chapters JSON file. Re-fetches when `url` changes. */
export function useChapters(url: string): { chapters: ChapterEntry[] | null; loading: boolean } {
  const [chapters, setChapters] = useState<ChapterEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!url) {
      setChapters(null);
      setLoading(false);
      return;
    }
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
          ? data.chapters.map((c: { startTime?: unknown; title?: unknown; img?: unknown; url?: unknown }) => ({
              startTime: Number(c.startTime) || 0,
              title: typeof c.title === 'string' ? c.title : undefined,
              img: typeof c.img === 'string' && c.img ? c.img : undefined,
              url: typeof c.url === 'string' && c.url ? c.url : undefined,
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

/** The chapters JSON url to fetch for a now-playing item, or '' to skip. Chapters
 *  are a podcast feature: gated off for live streams and music feeds. Shared by
 *  the players so the gate lives in one place. */
export function chapterUrlFor(
  current: { episode: Episode; podcast: Podcast } | null,
): string {
  if (!current || current.episode.liveStatus === 'live' || isMusicMedium(current.podcast)) {
    return '';
  }
  return current.episode.chaptersUrl ?? '';
}

/** Index of the chapter currently playing — the last one whose start has passed.
 *  -1 before the first chapter (or when there are none). */
function chapterIndexAt(chapters: ChapterEntry[] | null | undefined, positionSec: number): number {
  if (!chapters?.length) return -1;
  return chapters.reduce((acc, c, i) => (positionSec >= c.startTime ? i : acc), -1);
}

/** Seconds to seek to for "previous chapter": restart the current chapter when
 *  we're >3s into it (standard player behavior), else jump to the previous one. */
function chapterPrevTarget(chapters: ChapterEntry[], idx: number, positionSec: number): number {
  if (idx >= 0 && positionSec > chapters[idx].startTime + 3) return chapters[idx].startTime;
  if (idx > 0) return chapters[idx - 1].startTime;
  return 0;
}

/** Seconds to seek to for "next chapter", or null when already on the last. */
function chapterNextTarget(chapters: ChapterEntry[], idx: number): number | null {
  const n = chapters[idx + 1];
  return n ? n.startTime : null;
}

/** The active chapter + its bounds for the current playback position. */
export function chapterState(
  chapters: ChapterEntry[] | null,
  positionSec: number,
  duration: number,
): { index: number; chapter: ChapterEntry | null; end: number } {
  const index = chapterIndexAt(chapters, positionSec);
  const chapter = index >= 0 && chapters ? chapters[index] : null;
  const end = chapter && chapters ? chapters[index + 1]?.startTime ?? duration : 0;
  return { index, chapter, end };
}

/** A prev/next override for `<TransportControls>`. Structurally matches its
 *  `NavOverride` prop, so no shared type import is needed. */
interface ChapterNavButton {
  onClick: () => void;
  disabled: boolean;
  label: string;
}

/** Build the chapter-stepping prev/next overrides, or undefined when there are no
 *  chapters (callers then fall back to episode/track nav). `seek` is the player's
 *  own seek implementation (they differ between mini and fullscreen). */
export function buildChapterNav(
  chapters: ChapterEntry[] | null,
  activeIdx: number,
  positionSec: number,
  seek: (s: number) => void,
): { prev: ChapterNavButton; next: ChapterNavButton } | undefined {
  if (!chapters?.length) return undefined;
  return {
    prev: {
      onClick: () => seek(chapterPrevTarget(chapters, activeIdx, positionSec)),
      disabled: activeIdx <= 0 && positionSec <= 1,
      label: 'Previous chapter',
    },
    next: {
      onClick: () => {
        const t = chapterNextTarget(chapters, activeIdx);
        if (t != null) seek(t);
      },
      disabled: chapterNextTarget(chapters, activeIdx) == null,
      label: 'Next chapter',
    },
  };
}
