'use client';

// Shared list scaffolding for the favorites and results panels: medium
// bucketing, the nouns those buckets are labelled with, the collapse state
// those headings persist, and the progressive-reveal pager.
//
// Split out of the former single-file components/lists.tsx (1173 lines). These
// are the pieces used by MORE THAN ONE of the four list components, which is
// why they live together rather than beside whichever list happens to be their
// biggest consumer.

import { useCallback, useEffect, useRef, useState } from 'react';
import { storage } from '@/lib/storage';

/**
 * Group order for the favorites lists. Anything not named here sorts
 * alphabetically after these, and **medium-unknown is last and is its own
 * bucket** — never folded into `podcast`.
 *
 * That last part is the whole point of the position-4 hint. The list carries
 * podcasts and music at once by design, so whichever way you default you are
 * wrong about half of it, and an entry with no medium is one nobody has told us
 * about — which is not the same claim as "it's a podcast".
 */
const MEDIUM_ORDER = ['music', 'podcast', 'audiobook', 'film', 'video', 'newsletter', 'blog', 'publisher'];

/**
 * Split rows into medium buckets, in {@link MEDIUM_ORDER}, unknown last.
 *
 * Case is folded for BUCKETING only. The wire value is never normalized — the
 * medium vocabulary is open, so a value we don't recognize is one a newer app
 * does, and it gets its own bucket under its own label rather than being
 * dropped or coerced.
 */
export function groupByMedium<T>(rows: T[], mediumOf: (row: T) => string | undefined) {
  const buckets = new Map<string, { label: string; rows: T[] }>();
  const unknown: T[] = [];
  for (const row of rows) {
    const raw = mediumOf(row);
    if (!raw) { unknown.push(row); continue; }
    const key = raw.toLowerCase();
    const bucket = buckets.get(key) ?? { label: raw, rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }
  const rank = (key: string) => {
    const i = MEDIUM_ORDER.indexOf(key);
    return i === -1 ? MEDIUM_ORDER.length : i;
  };
  const groups = [...buckets.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([key, b]) => ({ key, label: b.label, rows: b.rows }));
  if (unknown.length) groups.push({ key: '~unknown', label: 'medium unknown', rows: unknown });
  return groups;
}

/**
 * Keys that name no medium, and so license no specific word.
 *
 * `'all'` is the favorites page's mixed view. `'~unknown'` is `groupByMedium`'s
 * own bucket for an entry whose medium nobody declared — and the entire point
 * of keeping that bucket separate is that "we were not told" is NOT the claim
 * "this is a podcast". A noun that then calls those rows shows and episodes
 * makes exactly the claim the bucket exists to refuse, in the button the user
 * presses to see more of them. Both fall back to the generic word.
 *
 * Held here rather than branched at the call site so one place owns the
 * vocabulary — two surfaces disagreeing about whether a row is an "episode" or
 * a "track" is the failure `<FavHeart>`'s `targetWord` already documents.
 */
function isMediumless(key: string): boolean {
  return key === 'all' || key === '~unknown';
}

/**
 * What one row of a favorited feed is called, by medium.
 *
 * A music feed's items are singles, not episodes — calling a track an episode
 * is wrong in the one place the user is most likely to be looking, since music
 * is the bulk of this list. Anything else keeps "episode": the alternatives
 * (chapters for an audiobook, and so on) are guesses about an open vocabulary,
 * and a wrong specific word reads worse than a right generic one.
 *
 * **Pass the number the word will be READ against, not the number of rows the
 * section holds.** These label a "show N more …" control, so `n` is what is
 * left — a section of thirteen with one row still hidden reads "show 1 more
 * singles" when the total is handed in instead.
 */
export function itemNoun(mediumKey: string, n: number): string {
  const one = isMediumless(mediumKey) ? 'favorite' : mediumKey === 'music' ? 'single' : 'episode';
  return n === 1 ? one : `${one}s`;
}

/**
 * What one favorited FEED is called, by medium — the `itemNoun` above one
 * level up. A favorited music feed is an album, not a show. Same rule about
 * which number to pass.
 */
export function feedNoun(mediumKey: string, n: number): string {
  const one = isMediumless(mediumKey) ? 'favorite' : mediumKey === 'music' ? 'album' : 'show';
  return n === 1 ? one : `${one}s`;
}

/**
 * What the favorites page's two halves are CALLED under a given tab.
 *
 * Distinct from `feedNoun`/`itemNoun` above because it labels a filter, not a
 * count, and a filter has to name a set the user can point at. The two are
 * therefore mediumless in opposite directions: the "show N more" control has a
 * heading right above it saying which half it belongs to, so `favorites` is
 * enough there, whereas these two chips sit side by side and are the ONLY thing
 * telling them apart — one word for both would make the control unusable.
 *
 * So a tab that names a medium gets one noun per chip, and a tab that names no
 * medium (`all`, `~unknown`) keeps the compound. The compound is not a fallback
 * to be tidied away: `all` really is mixed, and `~unknown` really is a bucket
 * nobody declared a medium for, so any single word there would assert something
 * the list does not know. Picking `shows`/`episodes` for it is the same wrong
 * claim `groupByMedium` keeps that bucket separate to refuse.
 *
 * The page uses these for the SECTION HEADINGS too. A chip reading ALBUMS above
 * a heading reading "albums & shows" is the same confusion one row down, and it
 * is the reason this returns both words from one call instead of leaving each
 * surface to build its own.
 */
export function splitLabels(mediumKey: string): { feeds: string; items: string } {
  if (isMediumless(mediumKey)) return { feeds: 'albums & shows', items: 'tracks & episodes' };
  return { feeds: feedNoun(mediumKey, 2), items: itemNoun(mediumKey, 2) };
}

/**
 * One chip on the MIXED tab, where a chip names a medium AND a half at once.
 *
 * `splitLabels` above answers "what are the two halves called under this tab".
 * This answers a different question the mixed tab asks: with no medium chosen,
 * one chip per half can only be a compound, so the row offers one chip per
 * (medium, half) pair instead and each has to name both.
 *
 * **Only `music` and `podcast` get the bare noun.** `feedNoun` collapses every
 * other medium to `show` and `itemNoun` to `episode`, which is the right call
 * for a lone label under a tab that already names the medium — and is a
 * COLLISION here, where the chips sit side by side: an audiobook and a podcast
 * would both render `SHOWS`, two identical buttons filtering to different
 * lists. So anything else is qualified by its own bucket label and takes the
 * neutral half-word. `medium unknown feeds` is deliberately not
 * `medium unknown shows`: the whole reason that bucket is separate is that
 * nobody declared what those entries are.
 */
export function crossSplitLabel(
  mediumKey: string,
  mediumLabel: string,
  kind: 'feeds' | 'items',
): string {
  if (mediumKey === 'music' || mediumKey === 'podcast') {
    return kind === 'feeds' ? feedNoun(mediumKey, 2) : itemNoun(mediumKey, 2);
  }
  return `${mediumLabel} ${kind}`;
}

/**
 * Remembered collapsed state for the favorites group headings.
 *
 * Initialized LAZILY from storage rather than loaded in an effect. That is safe
 * here for a specific reason: both favorites lists render only inside
 * `<HomePage>`'s favorites panel, which is gated on its `mounted` flag (the
 * store's `identity` starts null, so `favoritesDegraded` can't open the panel on
 * the first pass either), and both return null on an empty list — so there is no
 * server render for this value to disagree with. An effect would instead paint
 * every group expanded for a frame and then snap them shut, which is precisely
 * the flash that persisting the state is meant to avoid.
 *
 * **Call this ONCE PER LIST, never per group.** The two lists each holding a Set
 * is safe (see the toggle below); N groups each holding one would not be, since
 * their key spaces overlap within a list.
 */
export function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(storage.favCollapsed.get()));
  const toggle = (key: string) => {
    // Read-modify-write against STORAGE, not against local state. Both lists
    // mount this hook independently and the key holds one flat array covering
    // both namespaces, so writing `[...myOwnSet]` from the shows list would
    // silently erase every `ep:` key the episodes list had written, and vice
    // versa. The two in-memory Sets are then allowed to drift, because each
    // list only ever asks about keys in its own namespace.
    const next = new Set(storage.favCollapsed.get());
    if (!next.delete(key)) next.add(key);
    storage.favCollapsed.set([...next]);
    setCollapsed(next);
  };
  return [collapsed, toggle] as const;
}

/**
 * A group heading that folds its own group away.
 *
 * It always renders, including for a lone group — which reverses the old rule
 * that a single "PODCAST" banner was noise. That rule was right about a *banner*
 * and wrong about a *control*: the one-medium library is the one with no second
 * group to distinguish it from, and it is also the only one long enough to be
 * worth folding away.
 *
 * `controls` must be an id the caller got from `useId()`, NOT one built out of
 * the group key. A medium is feed-supplied and `groupByMedium` deliberately
 * never normalizes it beyond lowercasing, so `music video` — or any value with
 * stray whitespace — yields an id containing a space, and `aria-controls` is a
 * space-separated IDREF list. It would silently resolve to nothing for exactly
 * the unrecognized-medium groups that bucket exists to carry.
 */
export function CollapsibleHeading({
  label,
  collapsed,
  onToggle,
  controls,
  className,
}: {
  label: React.ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  controls: string;
  className: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-controls={controls}
      // `py-1.5` is a TOUCH TARGET, not spacing. `text-[11px]` gives a 16.5px
      // line box, and with no vertical padding this button was a 16.5px-tall
      // target — under WCAG 2.5.8's 24x24 minimum, measured at 390px. It was
      // survivable as a group heading inside the old favorites aside, where it
      // was one of many rows; on `/favorites` it is one of the page's two
      // primary controls, and the fold is the only way to skip a section
      // outright. 16.5 + 12 = 28.5px.
      className={`w-full text-[11px] uppercase tracking-widest text-muted px-1 py-1.5 flex items-center justify-between gap-2 hover:text-bone ${className}`}
    >
      <span className="text-left">{label}</span>
      <span aria-hidden className="text-bone/60">{collapsed ? '▸' : '▾'}</span>
    </button>
  );
}

/**
 * How many rows of one favorites group render before "show more".
 *
 * This is a BYTES cap wearing a UI hat. Each row mounts a <PodcastCover>
 * pointing at arbitrary third-party artwork, and podcast art in the wild is
 * routinely megabytes — measured on a real library: 55.6 MB of images across 84
 * requests, with a single 7.9 MB JPEG and a 4.8 MB animated GIF, all to paint
 * 56x56 tiles. On a slow connection that is minutes of downloading, and the
 * page never finishes.
 *
 * `loading="lazy"` alone was not enough: the browser still fetched most of a
 * long list because so much of it sits within its "near the viewport"
 * threshold. Not rendering the row at all is the reliable lever.
 *
 * Per GROUP rather than across the whole list, so each medium's heading can
 * keep stating its true total — a count that shrank to match what happened to
 * be revealed would be a worse lie than a long list.
 */
const FAV_PAGE = 12;

/**
 * Reveal a list in FAV_PAGE-sized steps. Returns the visible slice + control.
 *
 * `resetKey` is what makes this usable behind a filter, and the failure it
 * prevents runs the OPPOSITE way to the obvious one. Narrowing is already
 * safe: `slice(0, 12)` over three matches shows three. The expensive
 * direction is widening — reveal sixty rows, type a query, clear it, and
 * `shown` is still sixty, so sixty <PodcastCover>s mount in one commit
 * against arbitrary third-party artwork. That is the 55.6 MB page load the
 * cap above exists to stop, arrived at through the control that was supposed
 * to make the list smaller.
 *
 * Callers pass a string built from every control that changes WHICH rows
 * these are — query, medium tab, sort. Sort belongs in it even though it
 * changes no count: after a re-sort, "revealed sixty" names a different sixty.
 *
 * Adjusted during RENDER rather than in an effect, which is React's documented
 * pattern for state derived from changing props. **Do not "simplify" it into a
 * `useEffect`.** That version looks identical on screen and fixes nothing: the
 * over-large slice renders once before the effect trims it, and by then the
 * browser has already issued every image request this exists to prevent.
 *
 * Clamping alone is not enough and never was: a SHORTER list (an unfavorite)
 * still needs `remaining` floored at 0, which is why that stays.
 */
export function useRevealed<T>(rows: T[], resetKey?: string) {
  const [state, setState] = useState({ shown: FAV_PAGE, key: resetKey });
  // Referentially stable, because `useAutoReveal` takes it as an effect
  // dependency: an inline arrow would tear down and rebuild the observer on
  // every render of a list that re-renders whenever any favorite resolves.
  const more = useCallback(() => setState((s) => ({ ...s, shown: s.shown + FAV_PAGE })), []);
  let shown = state.shown;
  if (state.key !== resetKey) {
    shown = FAV_PAGE;
    setState({ shown: FAV_PAGE, key: resetKey });
  }
  // A shorter list (an unfavorite, a medium filter change) must not leave the
  // counter stranded above it, or "show more" renders with nothing to add.
  const visible = rows.slice(0, shown);
  const remaining = Math.max(0, rows.length - visible.length);
  return {
    visible,
    remaining,
    more,
  };
}

/**
 * The "show N more" control, shared by both favorites lists.
 *
 * **It is also the scroll sentinel** (see {@link useAutoReveal}), which is why
 * it takes a ref. Reusing the control rather than adding an invisible `<div>`
 * below it is what makes the automatic reveal degrade honestly: if
 * `IntersectionObserver` is missing the button is still a button, with no
 * second element to keep in sync and no state where the list has more rows and
 * nothing on screen offers them.
 */
export function ShowMore({
  remaining,
  onClick,
  noun,
  innerRef,
}: {
  remaining: number;
  onClick: () => void;
  noun: string;
  innerRef?: React.Ref<HTMLButtonElement>;
}) {
  if (remaining <= 0) return null;
  return (
    <button ref={innerRef} type="button" onClick={onClick} className="btn-ghost w-full mt-2 text-xs">
      show {Math.min(remaining, FAV_PAGE)} more {noun}
      {remaining > FAV_PAGE ? ` (${remaining} left)` : ''}
    </button>
  );
}

/**
 * Reveal the next page when the "show more" control scrolls into view.
 *
 * **This changes the TRIGGER, never the page size.** `FAV_PAGE` is a bytes cap
 * (see its own note): twelve rows is twelve `<PodcastCover>`s against arbitrary
 * third-party artwork, measured at 55.6 MB across 84 requests on a real
 * library. Auto-revealing is safe precisely because it still hands out twelve
 * at a time and only once the reader has actually arrived at the end of what is
 * already on screen — the bytes are spent in the same units, on the same
 * demand, without a press. What would NOT be safe is treating "they asked for
 * infinite scroll" as licence to raise the page size or drop the cap.
 *
 * **The effect re-runs on every `remaining` change, and that is load-bearing
 * rather than sloppy.** An `IntersectionObserver` fires on threshold CROSSINGS
 * only, so after a reveal that leaves the sentinel still on screen — a tall
 * viewport, or twelve short unresolved rows — no further callback ever comes
 * and the list stalls with rows left and nothing happening. Rebuilding the
 * observer delivers a fresh initial callback for the current state, so it
 * chains until the sentinel is pushed past the margin and then stops. It
 * terminates because each pass adds twelve rows and because the hook does
 * nothing at all once `remaining` hits 0.
 *
 * `rootMargin` is deliberately modest. A large one prefetches well ahead of the
 * reader, which is the whole cost this is meant to keep bounded — and on the
 * mixed view the feeds section sits ABOVE the items section, so anything
 * generous means scrolling *past* the albums silently pays for every one of
 * them. Folding a section, or the split chips, is still the way to skip one
 * outright.
 */
export function useAutoReveal(remaining: number, more: () => void) {
  const ref = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    // No sentinel (nothing left to reveal) or no observer (an engine old enough
    // not to have one) — the button below stays, and stays pressable.
    if (!el || remaining <= 0 || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) more(); },
      { rootMargin: '200px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [remaining, more]);
  return ref;
}
