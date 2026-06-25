'use client';
import { fmt } from '@/lib/format';
import type { ChapterEntry } from '@/lib/chapters';

/**
 * Chapter tick marks for a seek bar, rendered as a fragment of absolutely-
 * positioned spans (no wrapper) so each player keeps its own
 * `relative flex items-center` wrapper around the <input>. Skips the 0s start so
 * a tick doesn't sit under the thumb at rest. Shared by both players.
 */
export function ChapterTicks({
  chapters,
  duration,
}: {
  chapters: ChapterEntry[] | null;
  duration: number;
}) {
  if (!(duration > 0) || !chapters?.length) return null;
  return (
    <>
      {chapters.map((c, i) =>
        c.startTime > 0 && c.startTime < duration ? (
          <span
            key={`${c.startTime}-${i}`}
            aria-hidden
            title={c.title}
            className="pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-px h-2.5 bg-bone/45"
            style={{ left: `${(c.startTime / duration) * 100}%` }}
          />
        ) : null,
      )}
    </>
  );
}

/**
 * The current-chapter label shown by the seek bar: `start–end · title`.
 * `className` carries the per-player size/margin. Renders null without a title.
 */
export function ChapterLabel({
  chapter,
  end,
  className = '',
}: {
  chapter: ChapterEntry | null;
  end: number;
  className?: string;
}) {
  if (!chapter?.title) return null;
  return (
    <div className={`truncate text-bolt/90 ${className}`} title={chapter.title}>
      <span className="text-bolt/60 tabular-nums">
        {fmt(chapter.startTime)}–{fmt(end)}
      </span>{' '}
      {chapter.title}
    </div>
  );
}
