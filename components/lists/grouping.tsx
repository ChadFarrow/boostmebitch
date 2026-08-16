'use client';

// Shared list scaffolding for the favorites and results panels: medium
// bucketing, the nouns those buckets are labelled with, the collapse state
// those headings persist, and the progressive-reveal pager.
//
// Split out of the former single-file components/lists.tsx (1173 lines). These
// are the pieces used by MORE THAN ONE of the four list components, which is
// why they live together rather than beside whichever list happens to be their
// biggest consumer.

import { useState } from 'react';
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
 * What one row of a favorited feed is called, by medium.
 *
 * A music feed's items are singles, not episodes — calling a track an episode
 * is wrong in the one place the user is most likely to be looking, since music
 * is the bulk of this list. Anything else keeps "episode": the alternatives
 * (chapters for an audiobook, and so on) are guesses about an open vocabulary,
 * and a wrong specific word reads worse than a right generic one.
 */
export function itemNoun(mediumKey: string, n: number): string {
  const one = mediumKey === 'music' ? 'single' : 'episode';
  return n === 1 ? one : `${one}s`;
}

/**
 * What one favorited FEED is called, by medium — the `itemNoun` above one
 * level up. A favorited music feed is an album, not a show.
 */
export function feedNoun(mediumKey: string, n: number): string {
  const one = mediumKey === 'music' ? 'album' : 'show';
  return n === 1 ? one : `${one}s`;
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
      className={`w-full text-[11px] uppercase tracking-widest text-muted px-1 flex items-center justify-between gap-2 hover:text-bone ${className}`}
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

/** Reveal a list in FAV_PAGE-sized steps. Returns the visible slice + control. */
export function useRevealed<T>(rows: T[]) {
  const [shown, setShown] = useState(FAV_PAGE);
  // A shorter list (an unfavorite, a medium filter change) must not leave the
  // counter stranded above it, or "show more" renders with nothing to add.
  const visible = rows.slice(0, shown);
  const remaining = Math.max(0, rows.length - visible.length);
  return {
    visible,
    remaining,
    more: () => setShown((n) => n + FAV_PAGE),
  };
}

/** The "show N more" control, shared by both favorites lists. */
export function ShowMore({ remaining, onClick, noun }: { remaining: number; onClick: () => void; noun: string }) {
  if (remaining <= 0) return null;
  return (
    <button type="button" onClick={onClick} className="btn-ghost w-full mt-2 text-xs">
      show {Math.min(remaining, FAV_PAGE)} more {noun}
      {remaining > FAV_PAGE ? ` (${remaining} left)` : ''}
    </button>
  );
}
