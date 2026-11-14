// Following a favorite whose feed host closed.
//
// IMPORT-FREE, not even `import type`: `npm run check:moved` loads this file
// under plain Node (`scripts/import-free.mjs`). The record shapes below are
// local structural types for that reason.
//
// **Measured 2026-11-14 (Chad: "a lot of cover art is missing" on
// /favorites).** 33 of 468 favorites had no cover that loaded, and 32 were on
// RSS Blue, which closed ("RSS Blue is now part of Fountain"). Every
// `feeds.rssblue.com/<slug>` feed and every `media.rssblue.com` file — covers
// AND audio, also behind `op3.dev/e,pg=…/` — answers 410. Podcast Index still
// serves the old records as healthy (`dead: 0`, `lastHttpStatus: 200`, last
// crawl 2025-08-07), and `/podcasts/byguid` returns the dead copy even where a
// live one carries the SAME guid (Worried: dead 7101864, live Fountain
// 7520866 — only `/search/bytitle` shows it). Three more albums moved to a NEW
// guid (Prosperous Soul's Mr. Videoman, Runaway Train, Keep Searching).
//
// **Why a list of closed hosts and not a probe.** PI's own fields call these
// feeds alive, and crawl age does not separate them: 14 LIVE feeds on the same
// list were last crawled more than 180 days ago (wavlake, doerfelverse,
// behindthesch3m3s), next to the RSS Blue ones at 331–464 days. A probe would
// put a third-party fetch behind each of ~231 resolves to find fifteen. A
// host list costs nothing for a healthy feed. Adding the next closed host is
// one entry here plus its measurement.
//
// Design: docs/superpowers/specs/2026-11-14-moved-feeds-design.md.

export const CLOSED_HOSTS: readonly { name: string; hosts: readonly string[]; since: string }[] = [
  { name: 'RSS Blue', hosts: ['feeds.rssblue.com', 'media.rssblue.com'], since: '2026-11-14' },
];

/**
 * The closed service a URL belongs to, or null.
 *
 * Matches the URL's own host EXACTLY, and a closed host that appears as a
 * whole PATH SEGMENT — that is how an analytics prefix carries the real file
 * (`op3.dev/e,pg=…/media.rssblue.com/…`, `podtrac.com/…/redirect.mp3/
 * media.rssblue.com/…`), and every RSS Blue enclosure went through op3. Never a
 * substring: `media.rssblue.com.evil.example` is somebody else's host.
 */
export function closedService(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const segments = u.pathname.toLowerCase().split('/');
  for (const svc of CLOSED_HOSTS) {
    for (const h of svc.hosts) {
      if (host === h || segments.includes(h)) return svc.name;
    }
  }
  return null;
}

/**
 * Whether an item (an `Episode`, or a cached `FavoriteEpisode`) lives on a
 * closed host — its audio, its cover or its feed's cover. Any one is enough:
 * a cached favorite may hold only the cover, and every RSS Blue file is gone.
 */
export function itemOnClosedHost(item: { enclosureUrl?: string; image?: string; feedImage?: string }): boolean {
  return !!(closedService(item.enclosureUrl) || closedService(item.image) || closedService(item.feedImage));
}

/** Lower-case, `&` → `and`, every non-alphanumeric run → one space, trimmed.
 *  `Mr. Videoman` and `Mr Videoman` are the same album on two hosts. */
export function normTitle(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The fields of a RAW Podcast Index feed record these decisions read. */
export interface RawFeed {
  id?: number;
  podcastGuid?: string;
  url?: string;
  title?: string;
  author?: string;
  dead?: number;
  lastCrawlTime?: number;
}

/**
 * The live copy of a dead feed that carries the SAME guid, or null.
 *
 * This one is followed with NO press — its cover, its audio and, by Chad's
 * choice (2026-11-14), its value block. So a guid alone is not enough: Podcast
 * Index holds copycat feeds that reuse another feed's guid, and one would
 * collect the boosts. The author must match too (both copies of Worried say
 * "Suzanne Santo"); a dead record with no author has no twin.
 */
export function pickLiveTwin<F extends RawFeed>(dead: RawFeed, feeds: readonly F[]): F | null {
  const author = normTitle(dead.author);
  if (!dead.podcastGuid || !author) return null;
  let best: F | null = null;
  for (const f of feeds) {
    if (f.podcastGuid !== dead.podcastGuid) continue;
    if (f.id === undefined || f.id === dead.id) continue;
    if (f.dead === 1 || closedService(f.url)) continue;
    if (normTitle(f.author) !== author) continue;
    if (
      !best
      || (f.lastCrawlTime ?? 0) > (best.lastCrawlTime ?? 0)
      || ((f.lastCrawlTime ?? 0) === (best.lastCrawlTime ?? 0) && f.id > (best.id ?? 0))
    ) {
      best = f;
    }
  }
  return best;
}

/** At most this many copies are offered on one row. */
export const MAX_CANDIDATES = 3;

/**
 * Copies on a NEW guid that may be the dead album: same normalized title AND
 * same normalized artist, on a live host. These are only OFFERED — a title
 * alone matches strangers ("Runaway Train" has four unrelated feeds), and a
 * REPLACE changes a shared list and, through the new feed, who a boost pays.
 * A same-guid copy is never a candidate: `pickLiveTwin` already followed it.
 */
export function movedCandidates<F extends RawFeed>(dead: RawFeed, feeds: readonly F[]): F[] {
  const title = normTitle(dead.title);
  const author = normTitle(dead.author);
  if (!title || !author) return [];
  const out: F[] = [];
  const seen = new Set<number>();
  for (const f of feeds) {
    if (out.length >= MAX_CANDIDATES) break;
    if (f.id === undefined || f.id === dead.id || seen.has(f.id)) continue;
    if (!f.podcastGuid || f.podcastGuid === dead.podcastGuid) continue;
    if (f.dead === 1 || closedService(f.url)) continue;
    if (normTitle(f.title) !== title || normTitle(f.author) !== author) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}

/**
 * Old favorited tracks against a new album's items, by normalized title, one
 * to one in order. An old track with no title, or no match, is `unmatched` —
 * and an unmatched track STAYS on the list: losing a favorite is worse than
 * keeping a dead one.
 */
export function matchTracks(
  oldItems: readonly { itemGuid: string; title?: string }[],
  newItems: readonly { guid: string; title?: string }[],
): { moves: { oldItemGuid: string; newItemGuid: string }[]; unmatched: string[] } {
  const used = new Set<string>();
  const moves: { oldItemGuid: string; newItemGuid: string }[] = [];
  const unmatched: string[] = [];
  for (const o of oldItems) {
    const t = normTitle(o.title);
    const hit = t ? newItems.find((n) => !used.has(n.guid) && normTitle(n.title) === t) : undefined;
    if (hit) {
      used.add(hit.guid);
      moves.push({ oldItemGuid: o.itemGuid, newItemGuid: hit.guid });
    } else {
      unmatched.push(o.itemGuid);
    }
  }
  return { moves, unmatched };
}

export interface SwapInput {
  /** `'feed'` for an album row (the album and its favorited tracks), or the
   *  one track a track row stands for. */
  scope: 'feed' | { itemGuid: string };
  /** The dead album's own favorite, when it is one. */
  feedFav: { carried?: boolean } | null;
  /** The new album is already a favorite. */
  newFeedIsFav: boolean;
  /** Every favorited track under the dead album's guid. */
  oldItems: readonly { itemGuid: string; title?: string; carried?: boolean }[];
  newItems: readonly { guid: string; title?: string }[];
  /** Every favorited item guid, to avoid adding one twice. */
  favItemGuids: ReadonlySet<string>;
}

export interface SwapPlan {
  removeFeed: boolean;
  addFeed: boolean;
  /** `addNew: false` when the new track is already a favorite: the old one
   *  still goes, nothing is added twice. */
  moves: { oldItemGuid: string; newItemGuid: string; addNew: boolean }[];
  unmatched: string[];
}

/**
 * What one REPLACE does, decided before anything is written.
 *
 * A CARRIED entry is never in the plan: it lives in the half this device does
 * not publish (`localFavoriteEntries` skips it), so removing it locally would
 * change nothing on the wire and come back on the next hydrate.
 */
export function planSwap(input: SwapInput): SwapPlan {
  const { scope, feedFav, newFeedIsFav, newItems, favItemGuids } = input;
  const own = input.oldItems.filter((o) => !o.carried);
  const inScope = scope === 'feed' ? own : own.filter((o) => o.itemGuid === scope.itemGuid);
  const { moves, unmatched } = matchTracks(inScope, newItems);
  const feedSwap = scope === 'feed' && !!feedFav && !feedFav.carried;
  return {
    removeFeed: feedSwap,
    addFeed: feedSwap && !newFeedIsFav,
    moves: moves.map((m) => ({ ...m, addNew: !favItemGuids.has(m.newItemGuid) })),
    unmatched,
  };
}

/**
 * A favorites row after Podcast Index answered for it: the FRESH row, with
 * three things kept from the row painted this cycle.
 *
 * - `medium`: a resolved one wins; PI not reporting one must not blank the hint
 *   another app put on the wire.
 * - `addedAt`: a real one is kept, so a backfill does not bubble the row to the
 *   top; a placeholder's 0 is not inherited.
 * - `carried`: set by the paint loop THIS cycle, so it is not stale. The merge
 *   used to rebuild the row without it, which made a row the device must not
 *   publish look like its own until the next hydrate. Re-resolving rows on a
 *   closed host sends more rows through here, which is why it is pinned now.
 */
export function mergeResolvedRow<T extends { addedAt: number; medium?: string; carried?: boolean }>(
  prev: T | undefined,
  fresh: T,
): T {
  if (!prev) return fresh;
  return {
    ...fresh,
    medium: fresh.medium ?? prev.medium,
    addedAt: prev.addedAt ? prev.addedAt : fresh.addedAt,
    carried: prev.carried,
  };
}
