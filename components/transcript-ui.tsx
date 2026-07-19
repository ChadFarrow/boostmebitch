'use client';
import { useEffect, useRef } from 'react';
import { fmt } from '@/lib/format';
import type { TranscriptCue } from '@/lib/transcript';

/**
 * Scrollable transcript with the current line highlighted. Whenever a line is
 * active (activeIdx >= 0, i.e. this episode is playing) the box auto-scrolls it
 * into view — within its own bounded scroll region, never the page — in both the
 * player and the read-only detail view. When `onSeek` is given each line is also
 * tap-to-seek; without it the panel is read-only. Renders a loading skeleton
 * while `loading`, and null when there are no cues.
 */
export function TranscriptPanel({
  cues,
  activeIdx,
  onSeek,
  loading,
  className = '',
}: {
  cues: TranscriptCue[] | null;
  activeIdx: number;
  onSeek?: (s: number) => void;
  loading: boolean;
  className?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLElement>(null);

  // Keep the active line centered by scrolling only this container — scrollIntoView
  // would bubble up and move the whole page as playback advances. Safe in both
  // surfaces (player + detail view) because the box is its own bounded scroll
  // region, so following playback here never yanks the page. Position is measured
  // with getBoundingClientRect (relative to the box's current scroll), NOT
  // offsetTop — offsetTop is relative to the nearest *positioned* ancestor, which
  // isn't the box, so it scrolled to the wrong place.
  useEffect(() => {
    if (activeIdx < 0) return;
    const box = boxRef.current;
    const row = activeRef.current;
    if (!box || !row) return;
    const boxRect = box.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const target = box.scrollTop + (rowRect.top - boxRect.top) - box.clientHeight / 2 + rowRect.height / 2;
    box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }, [activeIdx]);

  if (loading && !cues?.length) {
    return <p className="text-xs text-muted">Loading transcript…</p>;
  }
  if (!cues?.length) return null;

  const seekable = !!onSeek;
  // A single untimed cue (startTime 0, whole text) has no meaningful sync — show
  // it as a plain readable block rather than a one-row seek list.
  const untimed = cues.length === 1 && cues[0].startTime === 0;

  if (untimed) {
    return (
      <div className={`max-h-96 overflow-y-auto text-sm text-bone/80 leading-relaxed whitespace-pre-wrap break-words ${className}`}>
        {cues[0].text}
      </div>
    );
  }

  return (
    <div ref={boxRef} className={`max-h-96 overflow-y-auto ${className}`}>
      <ul className="text-xs">
        {cues.map((c, i) => {
          const on = i === activeIdx;
          const body = (
            <>
              <span className={`tabular-nums w-12 flex-shrink-0 ${on ? 'text-bolt' : 'text-muted'}`}>
                {fmt(c.startTime)}
              </span>
              <span className="break-words">
                {c.speaker && <span className="text-muted font-semibold">{c.speaker}: </span>}
                {c.text}
              </span>
            </>
          );
          const rowCls = `w-full flex gap-3 items-baseline text-left rounded transition py-1.5 px-2 -mx-2 ${
            on ? 'bg-bolt/10 text-bolt' : 'text-bone/80'
          }`;
          return (
            <li key={`${c.startTime}-${i}`} ref={on ? (activeRef as React.RefObject<HTMLLIElement>) : undefined}>
              {seekable ? (
                <button type="button" onClick={() => onSeek!(c.startTime)} className={`${rowCls} hover:bg-bone/5`}>
                  {body}
                </button>
              ) : (
                <div className={rowCls}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
