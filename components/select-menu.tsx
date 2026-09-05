'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * One choice out of a fixed set: a button naming the current choice, and a menu.
 *
 * TWO SURFACES USE IT and that is the whole reason it exists here rather than
 * inside either. The search box's content-type selector and `/favorites`'
 * library filter are the same control — a short list of mutually exclusive
 * options over a list the user is looking at — and both arrived at the same
 * shape by the same route. Each shipped as a ROW of chips, and each row ran off
 * the edge of a phone: the search chips wrapped to two lines at 320px, a filter
 * standing taller than the box it filters, and the favorites row (up to sixteen
 * segments once every medium carries three) clipped mid-word at 390px with
 * `⚡ N…` and `PO…` sliced in half. A row that scrolls does not read as
 * scrollable when its last option is cut, it reads as broken — and the options
 * past the cut are exactly the ones nobody thinks to look for.
 *
 * A menu states the current choice in one word and costs one line at every
 * width. It is also how podcastindex.org presents the same choice, which is
 * worth something by itself: these users are already reading that site.
 *
 * **`role="menuitemradio"`, not `menuitem`.** This is one choice out of a fixed
 * set, and `aria-checked` is what makes the ✓ mean something to a screen reader
 * rather than being decoration next to a name.
 *
 * **Dismissal is the mousedown-outside + Escape pair**, and it needs both:
 * Escape alone strands the menu open under a thumb, and click-outside alone
 * strands it open for anyone on a keyboard. Both tests are `?.` so an unmounted
 * trigger closes rather than no-ops — see the MORE menu in
 * `episode-detail-view.tsx` for the leak that guard exists to prevent.
 *
 * **It PORTALS to `document.body`.** `app/layout.tsx` wraps `{children}` in
 * `relative z-0`, a stacking context, so nothing a page renders can rise above
 * `<TabBar>`'s `z-30` however high its own z-index. Both of today's callers sit
 * near the top of their page and would get away with `absolute`; a third one
 * lower down would not, and would fail by being painted under the dock rather
 * than by erroring.
 */
export type SelectOption<T extends string> = {
  id: T;
  /** The word in the menu. */
  label: string;
  /**
   * What the TRIGGER says when this option is active. Defaults to `label`.
   * An indented option needs it: "albums" alone does not say which medium's.
   */
  triggerLabel?: string;
  /** Dimmed trailing number. Omitted rather than rendered as 0. */
  count?: number;
  /** A sub-choice of the option above it — one indent step, no separators. */
  indent?: boolean;
};

export function SelectMenu<T extends string>({
  options,
  active,
  onChange,
  label,
  className = '',
}: {
  options: SelectOption<T>[];
  active: T;
  onChange: (id: T) => void;
  /** Names the control for a screen reader: "Search type: music". */
  label: string;
  /** Positioning for the wrapper. The trigger's own look is not overridable. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null);
  const current = options.find((o) => o.id === active) ?? options[0];

  // Measured from the trigger, and again on scroll and resize: a `fixed`
  // element does not follow the page. Below when there is room, above
  // otherwise, and never wider than the viewport allows.
  const place = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.min(r.left, Math.max(8, window.innerWidth - 8 - 220));
    const width = Math.min(280, window.innerWidth - left - 8);
    const below = window.innerHeight - r.bottom;
    setAt(
      below >= 220 || below >= r.top
        ? { top: r.bottom + 4, left, width }
        : { bottom: window.innerHeight - r.top + 4, left, width },
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    function onMouseDown(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  if (!current) return null;

  return (
    <div className={`relative ${className}`}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${current.triggerLabel ?? current.label}`}
        className="flex items-center gap-2 px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider border border-bone/30 text-muted transition hover:border-bone/60 hover:text-bone"
      >
        <span className="text-bone">{current.triggerLabel ?? current.label}</span>
        {current.count === undefined ? null : <span className="opacity-60">{current.count}</span>}
        <span className="text-[10px] opacity-40">{open ? '▴' : '▾'}</span>
      </button>

      {open && at && createPortal(
        <div
          ref={menuRef}
          role="menu"
          // `max-h` + scroll because the favorites list is as long as the
          // library has media; the search box's five never reach it.
          className="fixed z-40 card bg-ink p-1 shadow-xl max-h-[60vh] overflow-y-auto overscroll-contain"
          style={{ top: at.top, bottom: at.bottom, left: at.left, width: at.width }}
        >
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="menuitemradio"
              aria-checked={o.id === active}
              onClick={() => { onChange(o.id); setOpen(false); }}
              className={`flex w-full items-center gap-2 py-2 pr-2 text-left text-xs font-mono uppercase tracking-wider transition ${
                o.indent ? 'pl-7' : 'pl-2'
              } ${o.id === active ? 'text-bolt' : 'text-muted hover:bg-bone/5 hover:text-bone'}`}
            >
              {/* A fixed gutter for the ✓, so every label starts at the same x
                  whether or not its row is the checked one. A tick that shifts
                  the text makes the list appear to jitter as you move down it. */}
              <span className="w-3 shrink-0" aria-hidden>{o.id === active ? '✓' : ''}</span>
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.count === undefined ? null : <span className="opacity-60 shrink-0">{o.count}</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
