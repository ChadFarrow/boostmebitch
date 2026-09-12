'use client';

/**
 * The tab strip over a set of content panels — show notes / tracks /
 * transcript / boosts on the episode page, about / tracks / transcript in the
 * fullscreen player.
 *
 * ONE component, because there were two copies of a pill strip and they had
 * already drifted (different label sets for the same tab, one with `shadow-sm`
 * on the active pill). Both call sites keep their own tab LIST and active
 * state — which sections exist is their business — and hand this the ids and
 * labels.
 *
 * Square, not pills. Every other control in this app is square-edged: `.btn`,
 * `.stamp`, `.card`, the seek thumb. A `rounded-full` strip with a solid
 * yellow active pill was the one rounded shape on a page of right angles, and
 * it read as a component from a different kit. The active tab is a 2px bolt
 * underline on a hairline; the row stays quiet and the content below it is
 * what carries the colour.
 *
 * 44px tall (`h-11`): the old pills were 32px, under the 44px touch floor the
 * rest of the app holds and only just over WCAG's 24px minimum. Width stays
 * content-sized with `px-3.5`, so a long `Chapters (14)` label still fits four
 * tabs on a 390px screen with room to swipe.
 *
 * `overscroll-x-contain` stays — see the rail in podroll.tsx: a swipe past the
 * end of this row must not chain to the document or become a back-swipe. It
 * matters most in the fullscreen player, where the row sits inside a `fixed`
 * overlay and a chained swipe drags the overlay itself off the screen.
 *
 * NOTHING INSIDE MAY OVERFLOW THE STRIP VERTICALLY. `overflow-x-auto` computes
 * overflow-y to `auto` — CSS will not give one axis a scroll and leave the
 * other `visible` — so this row is a vertical scroll container whether or not
 * anyone wanted one, and a single pixel of overflow is draggable on a
 * touchscreen. See the active underline below for the pixel that was.
 */
export type UnderlineTab<T extends string> = { id: T; label: string };

/**
 * The props the CALLER's panel must carry, so the `role="tablist"` below is not
 * a promise the markup breaks.
 *
 * `docs/ui.md` carried this as an open item: the strip declared
 * `role="tablist"`/`role="tab"` "without the keyboard contract: no
 * `aria-controls`, no `role="tabpanel"` on the panels, no roving `tabIndex`, no
 * arrow keys." Three of those four were since done — the roving `tabIndex`, the
 * arrows and Home/End are all below — and what was left is the part the strip
 * CANNOT do alone: the panel is the caller's markup, so the association has to
 * be handed out rather than rendered here.
 *
 * ONE panel id, not one per tab. Both call sites render a single pane at a time
 * from a chain of `{active === 'x' && …}` siblings, so there is one logical panel
 * whose contents swap; `aria-labelledby` follows the active tab and names which.
 * Giving each tab its own panel id would describe a structure the DOM does not
 * have.
 *
 * NO `tabIndex` on the panel. WAI-ARIA wants a tabpanel focusable only when it
 * holds nothing focusable of its own, and these hold links, buttons, seek rows
 * and a transcript — so adding one would insert a tab stop in front of all of
 * them and make the keyboard worse in exchange for a conformance box.
 */
export function tabPanelProps<T extends string>(idBase: string, active: T) {
  return {
    id: `${idBase}-panel`,
    role: 'tabpanel' as const,
    'aria-labelledby': `${idBase}-tab-${active}`,
  };
}

export function UnderlineTabs<T extends string>({
  tabs,
  active,
  onChange,
  idBase,
  className = '',
}: {
  tabs: UnderlineTab<T>[];
  active: T;
  onChange: (id: T) => void;
  /**
   * REQUIRED, and required on purpose: it is what links each tab to the panel.
   * Pass a `useId()` from the caller, and spread `tabPanelProps(idBase, active)`
   * on the element holding the panes. Making it optional would let a new call
   * site type-check while re-opening the gap this closed.
   */
  idBase: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={`flex max-w-full overflow-x-auto overscroll-x-contain border-b border-bone/15 ${className}`}
      // Roving focus: `role="tablist"` promises ←/→ between tabs with one tab
      // stop for the strip (WAI-ARIA tabs). Only the active tab is in the tab
      // order; the arrows select AND focus, Home/End jump to the ends.
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
        const idx = Math.max(0, tabs.findIndex((t) => t.id === active));
        const next =
          e.key === 'ArrowLeft' ? (idx - 1 + tabs.length) % tabs.length
          : e.key === 'ArrowRight' ? (idx + 1) % tabs.length
          : e.key === 'Home' ? 0
          : tabs.length - 1;
        e.preventDefault();
        onChange(tabs[next]!.id);
        e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
      }}
    >
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${idBase}-tab-${t.id}`}
            aria-controls={`${idBase}-panel`}
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={`relative shrink-0 whitespace-nowrap h-11 px-3.5 text-xs font-semibold uppercase tracking-widest transition ${
              on ? 'text-bone' : 'text-muted hover:text-bone'
            }`}
          >
            {t.label}
            {/* `bottom-0`, and it MUST NOT go back to `-bottom-px`.
                `overflow-x-auto` on the strip computes overflow-y to `auto`
                (CSS will not give one axis a scroll and leave the other
                visible), so the strip is a VERTICAL scroll container too — and
                a bar hanging 1px below the button's content box is 1px of
                scrollable overflow in it. Measured under Chromium at 390px:
                scrollHeight 45 against clientHeight 44. One pixel is enough to
                drag and rubber-band on iOS, which is what made this strip
                creep up and down under a thumb while the page stayed still.
                At `bottom-0` the bar sits on the hairline instead of over it —
                a 2px bolt stroke above a 1px border-bone/15 line, which is the
                same stroke to look at and no overflow at all. */}
            {on && <span aria-hidden className="absolute left-3.5 right-3.5 bottom-0 h-0.5 bg-bolt" />}
          </button>
        );
      })}
    </div>
  );
}
