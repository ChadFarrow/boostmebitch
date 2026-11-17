// Typo matches over the shows this device already holds: the favorites and the
// play history. No network call — the lists are in the store already.
//
// Podcast Index's `/search/byterm` forgives no typo: `muton` and `homegrown
// hitz` answer 0 rows, while `mutton` and `homegrown hits` find the shows. The
// rows this module returns are rendered BELOW Podcast Index's, under their own
// heading, and only when that search came back thin. The rule and its limits
// live in docs/ui.md, "Typo matches from your saved shows".
//
// Pure, with type-only imports, so a script can load it under
// `node --experimental-strip-types`.

import type { FavoritePodcast, HistoryItem, Podcast } from './types';

/** Saved-show matches show only when the search returned FEWER rows than this. */
export const SAVED_MATCH_THIN = 5;

/** At most this many saved-show matches under one search. */
export const SAVED_MATCH_MAX = 5;

/**
 * Whether `a` and `b` are at most `max` edits apart — insert, delete, substitute,
 * or swap two neighbouring letters (optimal string alignment).
 *
 * The same test, with the same budget below, as the playlist near-match in
 * #592 (`editDistanceWithin` in lib/util.ts there). A copy on purpose while
 * that PR is open, so the two land without a conflict; once both are on main,
 * one of them imports the other.
 *
 * Bounded: a length gap above `max` answers at once, and a row whose best cell
 * is already past `max` stops the walk.
 */
function editDistanceWithin(a: string, b: string, max: number): boolean {
  if (max < 0) return false;
  if (Math.abs(a.length - b.length) > max) return false;
  if (a === b) return true;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prev2[j - 2] + 1);
      }
      cur.push(d);
      if (d < best) best = d;
    }
    if (best > max) return false;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length] <= max;
}

/** Lower case, accents dropped, so `Øystein` and `oystein` are one word. */
function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * How many typos one query term may carry: none under four letters, one up to
 * seven, two from eight. A short term with a typo allowed matches half the
 * dictionary — `pod` is one edit from `god`, `pot` and `pop`.
 */
function termBudget(term: string): number {
  if (term.length < 4) return 0;
  return term.length < 8 ? 1 : 2;
}

/**
 * One term against one show's words: within budget of a whole word, or of the
 * word's opening letters (the box searches as the user types, so `mutto` is a
 * word on its way to `mutton`).
 */
function termNearlyIn(term: string, words: readonly string[]): boolean {
  const max = termBudget(term);
  if (max === 0) return false;
  return words.some((w) => editDistanceWithin(term, w, max)
    || (w.length > term.length && editDistanceWithin(term, w.slice(0, term.length), max)));
}

/** Every key a show can be recognised by, so two copies of one show meet on any of them. */
function showKeys(p: Pick<Podcast, 'id' | 'podcastGuid' | 'url'>): string[] {
  const keys: string[] = [];
  if (p.podcastGuid) keys.push(`guid:${p.podcastGuid}`);
  if (p.id > 0) keys.push(`id:${p.id}`);
  if (p.url) keys.push(`url:${p.url}`);
  return keys;
}

/**
 * The saved shows as `Podcast` rows: the favorites first, newest added first,
 * then the play history, newest listen first. One row per show.
 *
 * - **A carried favorite is left out.** It is another writer's entry, so its
 *   heart would change the store and never the list (`carried` in
 *   lib/types.ts); `/favorites` renders it without one for the same reason.
 * - **A favorite with no title is left out.** It has not resolved yet, and
 *   there is nothing to match a query against.
 * - **No row carries a value block.** These are copies read from disk, and a
 *   copy from disk names no payee (`withoutStoredValue`). The show page loads
 *   the feed itself, as it does for a row on `/favorites`.
 */
export function savedShows(
  favorites: Readonly<Record<string, FavoritePodcast>>,
  history: readonly HistoryItem[],
): Podcast[] {
  const out: Podcast[] = [];
  const seen = new Set<string>();
  const add = (p: Podcast) => {
    const keys = showKeys(p);
    if (!keys.length || keys.some((k) => seen.has(k))) return;
    keys.forEach((k) => seen.add(k));
    out.push(p);
  };
  const favs = Object.values(favorites)
    .filter((f) => !f.carried && !!f.title?.trim())
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  for (const f of favs) {
    add({
      id: f.id,
      podcastGuid: f.podcastGuid,
      title: f.title!,
      author: f.author,
      image: f.image,
      artwork: f.artwork,
      url: f.url,
      medium: f.medium,
    });
  }
  for (const h of history) {
    const p = h.podcast;
    if (!p?.title?.trim()) continue;
    add({
      id: p.id,
      podcastGuid: p.podcastGuid,
      title: p.title,
      author: p.author,
      image: p.image,
      artwork: p.artwork,
      url: p.url,
      medium: p.medium,
      isPreview: p.isPreview,
    });
  }
  return out;
}

/**
 * The saved shows a query names, exact matches first, then the ones it reaches
 * only through a typo. A show already in `listed` (the rows Podcast Index
 * returned) is left out, so no show is on screen twice.
 *
 * A term lands when it is a substring of the title or author, or when it is
 * within `termBudget` edits of one of their words. Every term must land. So
 * `muton` finds Mutton, Mead & Music, `homegrown hitz` finds Homegrown Hits,
 * and `pod` finds no new show.
 */
export function matchSavedShows(
  shows: readonly Podcast[],
  q: string,
  listed: readonly Podcast[],
  limit: number = SAVED_MATCH_MAX,
): Podcast[] {
  const terms = fold(q).split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  if (!terms.length || limit <= 0) return [];
  const onScreen = new Set(listed.flatMap(showKeys));
  const exact: Podcast[] = [];
  const near: Podcast[] = [];
  for (const p of shows) {
    if (showKeys(p).some((k) => onScreen.has(k))) continue;
    const hay = fold(`${p.title ?? ''} ${p.author ?? ''}`);
    if (terms.every((t) => hay.includes(t))) {
      exact.push(p);
      continue;
    }
    const words = hay.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (terms.every((t) => hay.includes(t) || termNearlyIn(t, words))) near.push(p);
  }
  return [...exact, ...near].slice(0, limit);
}
