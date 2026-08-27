'use client';

/**
 * The small mono filter chip, shared by every surface that narrows a list.
 *
 * It started module-private in `<FavoritesPage>` and the search selector wanted
 * the identical control, which is the point at which this repo's other widgets
 * (`<CopyLinkButton>`, `<ValueSplitRows>`, `<RowThumb>`) have each been through
 * the same lesson: a second copy is how two surfaces come to disagree about the
 * same thing, and the drift is invisible because each screen looks right on its
 * own.
 *
 * **`aria-pressed` rather than `role="tab"`**, matching every other toggle here
 * — a real tablist owes arrow-key roving focus and a `tabpanel` to point at, and
 * these chips are filters over one list rather than pages of it.
 *
 * SIZE IS A CORRECTNESS PROPERTY, not styling. WCAG 2.5.8 puts the floor at
 * 24×24 CSS pixels and a chip is not the in-sentence-link exemption. `py-1` over
 * `text-[11px]`'s 16.5px line box lands at ~26.5px including the border, which
 * clears it — `<CollapsibleHeading>` shipped at 16.5px by leaving the padding
 * off, and the miss is invisible in review because the element looks right at
 * every size except the one a finger is. Measure before changing the padding.
 */
export function Chip({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={`px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider border transition ${
        active
          ? 'border-bolt text-bolt bg-bolt/10'
          : 'border-bone/30 text-muted hover:border-bone/60 hover:text-bone'
      }`}
    >
      {children}
    </button>
  );
}
