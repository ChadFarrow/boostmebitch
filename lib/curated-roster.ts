import { getPublisherAlbumUrls } from '@/lib/musicl-resolver';
import { resolveFeedUrls } from '@/lib/feed-resolve';
import { createBoundedCache } from '@/lib/bounded-cache';
import { feedUrlKey, filterPlaylistsByQuery, communityPlaylistToPodcast } from '@/lib/util';
import { MUSICL_PUBLISHER_URL, COMMUNITY_PLAYLIST_URLS, COMMUNITY_PLAYLISTS_ON } from '@/lib/curated-playlists';
import { communityStoreConfigured, listPlaylists } from '@/lib/community/store';
import { summaryOf } from '@/lib/community/http';
import type { Podcast } from '@/lib/types';

/**
 * The playlists the app's own collections list, as a search lane.
 *
 * Server-only. Every other `/api/search` lane asks Podcast Index, so a playlist
 * PI has not indexed yet could not be found by name at all — even while
 * `/playlists` listed it, from the same publisher feed. Reported as #529: "Top
 * 100 Songs on OnlyBoosts" is a child of `chadf-musicl-publisher.xml`, served
 * by `/api/publisher` with an RSS-only id, and searching its exact title under
 * PLAYLISTS answered "0 playlists". New playlists are built out there before
 * anyone submits them to PI, so this is the normal state for the newest ones,
 * not an edge case.
 *
 * The roster is the publisher feed's children plus `COMMUNITY_PLAYLIST_URLS` —
 * the two collections `/playlists` renders, read from the one list in
 * `lib/curated-playlists.ts` — resolved the way `/api/publisher` resolves them
 * (`resolveFeedUrls`): Podcast Index first, so a playlist PI holds keeps its PI
 * id, guid and favorite heart; the feed's own RSS for the rest.
 *
 * **An accelerator, never an authority**, like the PI playlist roster in
 * `lib/pi.ts` it sits beside: every failure is `[]`, so this lane can only make
 * a search LONGER than it would have been, never broken, and its absence is
 * never reported as "there are no playlists" — the empty state already says how
 * many results the other types hold.
 */

/**
 * How long one resolved roster is FRESH, and how long it is servable at all.
 *
 * Shorter than PI's playlist roster (6 h), on purpose: this one holds the
 * playlists that are still being BUILT, and a playlist added to the publisher
 * feed should be findable the same hour it appears on `/playlists`. A refresh is
 * one publisher read plus ~20 PI lookups and RSS reads, in the background, so
 * fifteen minutes costs little. The stale window serves the last good roster
 * through a failed refresh.
 */
const CURATED_FRESH_MS = 15 * 60_000;
const CURATED_STALE_MS = 24 * 60 * 60_000;
/**
 * How soon a DEGRADED refresh may be retried.
 *
 * A refresh is degraded when the publisher feed could not be read (so ChadF's
 * playlists are missing) or Podcast Index rate limited it (so every row is an
 * RSS preview with no PI id — no heart, and a NOT IN PI stamp on playlists PI
 * does hold). Neither is fit to serve for fifteen minutes, and retrying on every
 * search would spend the quota PI just told us we do not have. So a degraded
 * roster is stored as if it were this close to going stale.
 */
const CURATED_RETRY_MS = 60_000;
/**
 * How long a search waits on a COLD roster before going without the lane.
 *
 * The PI roster's argument, with a longer ceiling because the work is longer: a
 * publisher read, then a PI probe and a bounded fan-out, then RSS for the
 * misses. A search for a playlist's exact name on a fresh serverless instance
 * is precisely the search this lane exists for, so skipping it outright would
 * make the fix look broken and then work on a retry. Past the ceiling the
 * search proceeds without it, answers `no-store` (`CuratedHits.answered`), and
 * the refresh continues for the next one. Measured against the live hosts on
 * 2026-11-10: 1.3 s for a cold refresh, and once 2.5+ s while the same machine
 * was also resolving a 100-track playlist page against Podcast Index.
 */
const CURATED_COLD_WAIT_MS = 2500;
/** Same ceiling `/api/publisher` puts on a publisher's children. */
const MAX_CURATED = 100;

// ONE entry, through the shared bounded cache anyway — see the PI roster in
// lib/pi.ts for why "it is only one key" is not a reason to hand-roll one.
const roster = createBoundedCache<Podcast[]>({ maxAgeMs: CURATED_STALE_MS, maxEntries: 1 });
const ROSTER_KEY = 'curated';
let inFlight: Promise<Podcast[] | null> | null = null;

/** Every curated feed URL, publisher children first, deduped by `feedUrlKey`. */
function curatedUrls(children: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of [...children, ...COMMUNITY_PLAYLIST_URLS]) {
    const k = feedUrlKey(url);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(url);
  }
  return out.slice(0, MAX_CURATED);
}

async function refreshCuratedRoster(): Promise<Podcast[] | null> {
  const prev = roster.get(ROSTER_KEY, Date.now())?.value;
  // null = the publisher feed could not be READ, which is not "it lists
  // nothing". The community half is still worth resolving, but the result is
  // missing ChadF's own playlists and is treated as degraded below.
  const children = await getPublisherAlbumUrls(MUSICL_PUBLISHER_URL).catch(() => null);
  let resolved;
  try {
    resolved = await resolveFeedUrls(curatedUrls(children ?? []));
  } catch {
    // PI failing outright (auth, a 5xx). Byterm is failing too, so the search
    // this was for is already an error; keep whatever we had.
    return prev ?? null;
  }
  const feeds = resolved.feeds.filter((f): f is Podcast => f !== null);
  const degraded = children === null || resolved.couldNotAskPi;
  if (degraded) {
    // The last GOOD roster beats a degraded one: it has ChadF's playlists and
    // their PI ids. Re-stored rather than left alone, so the retry clock below
    // runs from now instead of firing on every search while it lasts.
    const keep = prev ?? feeds;
    roster.set(ROSTER_KEY, keep, Date.now() - (CURATED_FRESH_MS - CURATED_RETRY_MS));
    return keep;
  }
  roster.set(ROSTER_KEY, feeds, Date.now());
  return feeds;
}

/**
 * What the curated lane found, and whether it was able to look.
 *
 * `answered: false` means the roster was cold and did not resolve in time, or
 * could not be resolved at all — so `feeds` is empty because nobody asked, not
 * because nothing matched. **The route must not cache that answer.** It used to
 * get `s-maxage=60` like any other: measured on a dev server, one cold refresh
 * ran past the ceiling, the search answered "0 playlists" for an exact title,
 * and a CDN would have served that sentence to everyone for a minute after the
 * refresh had finished behind it. Same rule as `couldNotAsk` in `/api/playlist`.
 */
export interface CuratedHits {
  feeds: Podcast[];
  answered: boolean;
}

/**
 * Curated playlists whose title or author matches every term of `query`.
 *
 * `filterPlaylistsByQuery` is the same matcher the PI roster lane uses, so a
 * curated playlist matches exactly when an indexed one with the same title
 * would. Never throws: every failure is an empty, unanswered lane.
 */
export async function searchCuratedPlaylists(query: string, limit: number): Promise<CuratedHits> {
  const [curated, own] = await Promise.all([searchRoster(query, limit), searchCommunityStore(query, limit)]);
  return { feeds: [...curated.feeds, ...own].slice(0, limit), answered: curated.answered };
}

/** Stored community playlists whose title matches. Never throws: a database that is down is `[]`. */
async function searchCommunityStore(query: string, limit: number): Promise<Podcast[]> {
  if (!COMMUNITY_PLAYLISTS_ON || !communityStoreConfigured()) return [];
  try {
    const rows = await listPlaylists({ limit: 200 });
    return filterPlaylistsByQuery(rows.map((r) => communityPlaylistToPodcast(summaryOf(r))), query, limit);
  } catch {
    return [];
  }
}

async function searchRoster(query: string, limit: number): Promise<CuratedHits> {
  const hit = roster.get(ROSTER_KEY, Date.now());
  if (!hit || hit.ageMs >= CURATED_FRESH_MS) {
    // Deduped: concurrent searches on a cold or stale roster share one refresh.
    if (!inFlight) {
      inFlight = refreshCuratedRoster()
        .catch(() => null)
        .finally(() => { inFlight = null; });
    }
    if (!hit) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const feeds = await Promise.race([
        inFlight,
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), CURATED_COLD_WAIT_MS); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      return { feeds: filterPlaylistsByQuery(feeds ?? [], query, limit), answered: feeds != null };
    }
  }
  return { feeds: filterPlaylistsByQuery(hit.value, query, limit), answered: true };
}
