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
 */
export type UnderlineTab<T extends string> = { id: T; label: string };

export function UnderlineTabs<T extends string>({
  tabs,
  active,
  onChange,
  className = '',
}: {
  tabs: UnderlineTab<T>[];
  active: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={`flex max-w-full overflow-x-auto overscroll-x-contain border-b border-bone/15 ${className}`}
    >
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.id)}
            className={`relative shrink-0 whitespace-nowrap h-11 px-3.5 text-xs font-semibold uppercase tracking-widest transition ${
              on ? 'text-bone' : 'text-muted hover:text-bone'
            }`}
          >
            {t.label}
            {/* -bottom-px so the underline sits ON the container's hairline
                rather than a pixel above it — the two read as one stroke. */}
            {on && <span aria-hidden className="absolute left-3.5 right-3.5 -bottom-px h-0.5 bg-bolt" />}
          </button>
        );
      })}
    </div>
  );
}
