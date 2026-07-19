'use client';
import { useEffect, useRef, useState, Fragment } from 'react';
import { fmt } from '@/lib/format';
import type { TranscriptCue } from '@/lib/transcript';

// Split `text` on case-insensitive occurrences of `query`, wrapping matches in a
// tinted <mark>. indexOf-based (no regex) so any query — including chars like
// `.`/`(`/`*` — is treated literally and can't throw or inject a pattern.
function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  const out: React.ReactNode[] = [];
  let from = 0;
  let at = hay.indexOf(needle, from);
  let key = 0;
  while (at !== -1) {
    if (at > from) out.push(text.slice(from, at));
    out.push(
      <mark key={key++} className="bg-bolt/30 text-bolt rounded-sm">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
    at = hay.indexOf(needle, from);
  }
  if (from < text.length) out.push(text.slice(from));
  return out.map((n, i) => <Fragment key={i}>{n}</Fragment>);
}

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
  const [query, setQuery] = useState('');

  // Keep the active line centered by scrolling only this container — scrollIntoView
  // would bubble up and move the whole page as playback advances. Safe in both
  // surfaces (player + detail view) because the box is its own bounded scroll
  // region, so following playback here never yanks the page. Position is measured
  // with getBoundingClientRect (relative to the box's current scroll), NOT
  // offsetTop — offsetTop is relative to the nearest *positioned* ancestor, which
  // isn't the box, so it scrolled to the wrong place.
  useEffect(() => {
    // While filtering, matching rows are shown and the active playing line may be
    // hidden — don't chase it (activeIdx points into the full cues array).
    if (query) return;
    if (activeIdx < 0) return;
    const box = boxRef.current;
    const row = activeRef.current;
    if (!box || !row) return;
    const boxRect = box.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const target = box.scrollTop + (rowRect.top - boxRect.top) - box.clientHeight / 2 + rowRect.height / 2;
    box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }, [activeIdx, query]);

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

  // Case-insensitive filter to matching lines, keeping each cue's original index so
  // the active-line highlight (i === activeIdx) still lines up.
  const q = query.trim();
  const needle = q.toLowerCase();
  const rows = (q
    ? cues
        .map((c, i) => ({ c, i }))
        .filter(
          ({ c }) =>
            c.text.toLowerCase().includes(needle) ||
            (c.speaker?.toLowerCase().includes(needle) ?? false),
        )
    : cues.map((c, i) => ({ c, i })));

  return (
    <div className={className}>
      <div className="flex items-center gap-2 mb-2">
        <div className="relative flex-1">
          <input
            className="input w-full text-xs py-1 pr-8"
            placeholder="Search transcript…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear transcript search"
              className="absolute right-2 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded-full text-muted hover:bg-line hover:text-bone"
            >
              ×
            </button>
          )}
        </div>
        {q && (
          <span className="text-[11px] text-muted tabular-nums flex-shrink-0">
            {rows.length} match{rows.length === 1 ? '' : 'es'}
          </span>
        )}
      </div>
      <div ref={boxRef} className="max-h-96 overflow-y-auto">
        {q && rows.length === 0 ? (
          <p className="text-xs text-muted py-2">No matches.</p>
        ) : (
          <ul className="text-xs">
            {rows.map(({ c, i }) => {
              const on = i === activeIdx;
              const body = (
                <>
                  <span className={`tabular-nums w-12 flex-shrink-0 ${on ? 'text-bolt' : 'text-muted'}`}>
                    {fmt(c.startTime)}
                  </span>
                  <span className="break-words">
                    {c.speaker && (
                      <span className="text-muted font-semibold">{highlight(c.speaker, q)}: </span>
                    )}
                    {highlight(c.text, q)}
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
        )}
      </div>
    </div>
  );
}
