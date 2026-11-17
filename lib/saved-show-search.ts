// Typo matches over the shows this device already holds: the favorites and the
// play history. No network call — the lists are in the store already.
//
// Podcast Index's `/search/byterm` forgives no typo: `muton` and `homegrown
// hitz` answer 0 rows, while `mutton` and `homegrown hits` find the shows. The
// rows this module returns are rendered BELOW Podcast Index's, under their own
// heading, and only when that search came back thin. The rule and its limits
// live in docs/ui.md, "Typo matches from your saved shows".
//
// The typo test itself is `nearMatchKind` in lib/util.ts, the one #592's
// playlist near-match asks, so the two cannot disagree on what a typo is.

import type { FavoritePodcast, HistoryItem, Podcast } from './types';
import { nearMatchKind, nearMatchTerms } from './util';

/** Saved-show matches show only when the search returned FEWER rows than this. */
export const SAVED_MATCH_THIN = 5;

/** At most this many saved-show matches under one search. */
export const SAVED_MATCH_MAX = 5;

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
 * within an edit budget of one of their words (`nearMatchKind`). Every term must land. So
 * `muton` finds Mutton, Mead & Music, `homegrown hitz` finds Homegrown Hits,
 * and `pod` finds no new show.
 */
export function matchSavedShows(
  shows: readonly Podcast[],
  q: string,
  listed: readonly Podcast[],
  limit: number = SAVED_MATCH_MAX,
): Podcast[] {
  const terms = nearMatchTerms(q);
  if (!terms.length || limit <= 0) return [];
  const onScreen = new Set(listed.flatMap(showKeys));
  const exact: Podcast[] = [];
  const near: Podcast[] = [];
  for (const p of shows) {
    if (showKeys(p).some((k) => onScreen.has(k))) continue;
    const kind = nearMatchKind(terms, p.title, p.author);
    if (kind === 'exact') exact.push(p);
    else if (kind === 'near') near.push(p);
  }
  return [...exact, ...near].slice(0, limit);
}
