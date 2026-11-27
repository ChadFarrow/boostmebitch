'use client';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { UnderlineTabs, tabPanelProps } from '../underline-tabs';

/**
 * THE PHONE LAYOUT OF A LIVE SHOW WITH THE IRC CHAT: pages you flick, with the
 * player's controls pinned under them (docs/ui.md, "With the IRC chat on a
 * phone: a pager"). Chad, 2026-11-24, from his iPhone during MMO: the chat was
 * "only basically two lines", and Podverse's player is the model — "a player
 * and then you just kinda flick … while still playing".
 *
 * - **The flick is the browser's own**: a CSS scroll-snap row, one page per
 *   screen width, `snap-always` so a hard flick stops at the next page. No
 *   gesture code, so a vertical drag inside a page (the message list) is still
 *   the page's own scroll.
 * - **The strip is `<UnderlineTabs>`**: a tap scrolls to the page, and the
 *   scroll moves the underline. A page off screen is `inert`, so a tab key or
 *   a screen reader cannot land on what is not shown.
 * - **Every page stays mounted.** The CHAT page holds `<IrcChat>` (through a
 *   reverse portal in `<FullscreenPlayer>`), and an unmount leaves the channel.
 * - **The bar steps aside while a field on a page has focus.** The composer
 *   then sits at the overlay's bottom edge, where it was before this layout,
 *   which is the geometry iOS already handles with the keyboard up. It comes
 *   back a moment after the blur, so a tap on SEND lands before anything moves.
 *   "Has focus" is READ from `document.activeElement`, never kept from events:
 *   a focused button that turns `disabled` (SEND after a send) or a focused
 *   field that unmounts (the nick box on JOIN) fires no `focusout`, and a flag
 *   kept from events would hide play/pause and BOOST until the next blur.
 */
export type LivePagerPage = {
  id: string;
  label: string;
  body: ReactNode;
  /** The page scrolls itself. False for the chat, whose list is the scroller. */
  scroll: boolean;
};

const BAR_BACK_MS = 250;

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Fields that raise a keyboard. Not a range: the seek bar is on the PLAYER page. */
const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
function isField(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.tagName === 'TEXTAREA') return true;
  return t.tagName === 'INPUT' && TEXT_INPUTS.has((t as HTMLInputElement).type);
}

/** A field on one of the pager's pages has focus now. */
function fieldFocusedIn(root: HTMLElement | null): boolean {
  const a = typeof document === 'undefined' ? null : document.activeElement;
  return !!root && isField(a) && !(a as HTMLInputElement).disabled && root.contains(a);
}

/** While the bar is away, how often to look whether focus left by a path that fires nothing. */
const TYPING_POLL_MS = 500;

export function LiveChatPager({
  pages,
  initial,
  resetKey,
  bar,
  onPageChange,
}: {
  pages: LivePagerPage[];
  /** The page it opens on, and goes back to when `resetKey` changes. */
  initial: string;
  /** Another show: open on `initial` again. */
  resetKey: string;
  bar: ReactNode;
  /** The page now shown, so the owner can open on it again after a remount. */
  onPageChange?: (id: string) => void;
}) {
  const idBase = useId();
  const pagerRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(initial);
  const activeRef = useRef(active);
  activeRef.current = active;
  // A tap on the strip scrolls smoothly past the pages between; while it does,
  // the scroll must not move the underline through them.
  const targetRef = useRef<number | null>(null);
  const [typing, setTyping] = useState(false);
  const barTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ids = pages.map((p) => p.id);
  const idsKey = ids.join(',');

  // Another show opens on `initial`. Set during render, as `<FullscreenPlayer>`
  // does for its tabs, so no frame paints the old page.
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setActive(initial);
  }

  // PLACE THE ROW ON THE ACTIVE PAGE, with no animation: on mount, for another
  // show, and when a page comes or goes (PLAYED appears with the first song),
  // which moves the index of every page after it.
  useLayoutEffect(() => {
    const el = pagerRef.current;
    if (!el) return;
    const i = Math.max(0, idsKey.split(',').indexOf(activeRef.current));
    targetRef.current = null;
    el.scrollLeft = i * el.clientWidth;
  }, [idsKey, seenKey]);

  // A new width (a turn of the phone, the keyboard on some Androids) moves the
  // page boundaries; keep the active page in place.
  useEffect(() => {
    const el = pagerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w) return;
      w = el.clientWidth;
      const i = Math.max(0, idsKey.split(',').indexOf(activeRef.current));
      targetRef.current = null;
      el.scrollLeft = i * w;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [idsKey]);

  // TYPING, FROM THE DOM. Native `focusin`/`focusout`, never React's
  // `onFocus`: `<IrcChat>` is rendered through a reverse portal, and React
  // sends its events up the REACT tree, where the composer's parent is
  // `<FullscreenPlayer>`, not this pager. The DOM tree is where it sits. The
  // events only say WHEN to look; `fieldFocusedIn` says what is true.
  //
  // NOTHING MOVES UNDER A FINGER. The bar's return shrinks the pages and lifts
  // the composer about 90px, so while a pointer is down on the pages the bar
  // stays away, and the look waits `BAR_BACK_MS` after the finger lifts: a tap
  // from the composer to SEND lands on SEND.
  const downRef = useRef(false);
  useEffect(() => {
    const el = pagerRef.current;
    if (!el) return;
    const look = () => {
      if (barTimer.current) clearTimeout(barTimer.current);
      barTimer.current = setTimeout(() => {
        if (!downRef.current) setTyping(fieldFocusedIn(el));
      }, BAR_BACK_MS);
    };
    const onIn = () => {
      if (!fieldFocusedIn(el)) return;
      if (barTimer.current) clearTimeout(barTimer.current);
      setTyping(true);
    };
    const onDown = () => { downRef.current = true; };
    const onUp = () => { downRef.current = false; look(); };
    el.addEventListener('focusin', onIn);
    el.addEventListener('focusout', look);
    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('pointerup', onUp, true);
    el.addEventListener('pointercancel', onUp, true);
    return () => {
      el.removeEventListener('focusin', onIn);
      el.removeEventListener('focusout', look);
      el.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('pointerup', onUp, true);
      el.removeEventListener('pointercancel', onUp, true);
      if (barTimer.current) clearTimeout(barTimer.current);
    };
  }, []);
  // The paths that fire no event: a focused SEND turned `disabled`, a focused
  // nick box unmounted by JOIN. Only while the bar is away.
  useEffect(() => {
    if (!typing) return;
    const t = setInterval(() => {
      if (!downRef.current && !fieldFocusedIn(pagerRef.current)) setTyping(false);
    }, TYPING_POLL_MS);
    return () => clearInterval(t);
  }, [typing]);

  const onScroll = () => {
    const el = pagerRef.current;
    if (!el || !el.clientWidth) return;
    const target = targetRef.current;
    if (target !== null) {
      if (Math.abs(el.scrollLeft - target * el.clientWidth) > 2) return;
      targetRef.current = null;
    }
    const id = ids[Math.round(el.scrollLeft / el.clientWidth)];
    if (id && id !== activeRef.current) {
      activeRef.current = id;
      setActive(id);
    }
  };

  const go = (id: string) => {
    const el = pagerRef.current;
    const i = ids.indexOf(id);
    if (!el || i < 0) return;
    activeRef.current = id;
    setActive(id);
    const left = i * el.clientWidth;
    if (reducedMotion() || Math.abs(el.scrollLeft - left) < 2) {
      el.scrollLeft = left;
      return;
    }
    targetRef.current = i;
    el.scrollTo({ left, behavior: 'smooth' });
  };

  const activeId = ids.includes(active) ? active : ids[0]!;
  const onPageRef = useRef(onPageChange);
  onPageRef.current = onPageChange;
  useEffect(() => { onPageRef.current?.(activeId); }, [activeId]);

  return (
    <div data-live-pager className="flex-1 min-h-0 flex flex-col">
      <div data-live-tabs className="flex-shrink-0 px-2">
        <UnderlineTabs
          tabs={pages.map((p) => ({ id: p.id, label: p.label }))}
          active={activeId}
          idBase={idBase}
          onChange={go}
        />
      </div>
      <div
        ref={pagerRef}
        onScroll={onScroll}
        // A finger on the row ends a tap's smooth scroll as the owner of the
        // underline; from here the position says which page it is.
        onPointerDown={() => { targetRef.current = null; }}
        className="flex-1 min-h-0 flex overflow-x-auto overflow-y-hidden snap-x snap-mandatory overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {pages.map((p) => {
          const on = p.id === activeId;
          return (
            <section
              key={p.id}
              data-live-page={p.id}
              aria-label={p.label}
              inert={!on}
              {...(on ? tabPanelProps(idBase, activeId) : {})}
              className={`w-full flex-none snap-start snap-always min-h-0 flex flex-col ${
                p.scroll ? 'overflow-y-auto overscroll-y-contain' : 'overflow-hidden'
              }`}
            >
              {p.body}
            </section>
          );
        })}
      </div>
      {!typing && (
        <>
          {/* Square marks, the app's right angles: they say there is more to
              each side, which the strip alone does not. */}
          <div aria-hidden className="flex-shrink-0 flex justify-center gap-1.5 pt-1.5">
            {ids.map((id) => (
              <span key={id} className={`w-1.5 h-1.5 transition-colors ${id === activeId ? 'bg-bone' : 'bg-bone/20'}`} />
            ))}
          </div>
          <div data-live-bar className="flex-shrink-0 px-4 pt-2 pb-3 border-t border-bone/10 mt-1.5">
            {bar}
          </div>
        </>
      )}
    </div>
  );
}
