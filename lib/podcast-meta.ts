'use client';

// Unified `/api/by-guid` resolver used by anything that needs a Podcast
// from a podcast:guid identifier (favorites hydrator, global Nostr feed,
// per-podcast feed, podroll). Layers four guards so the endpoint isn't
// hammered when Podcast Index is unconfigured locally:
//
//   1. In-memory Map (fastest path within a page session).
//   2. localStorage `bmb:pmeta:<key>` cache (7-day TTL, survives reloads).
//   3. sessionStorage circuit breaker — once /api/by-guid 5xxs in this tab,
//      every subsequent caller short-circuits to null without a fetch.
//   4. The actual fetch.
//
// Callers using the breaker manually (e.g. probe-first batch patterns)
// can call `piMaybeUp()` before firing parallel resolves.
//
// Two lookup keys are supported: a podcast:guid (canonical) and a feed URL
// (the podroll fallback for feeds PI doesn't index by guid). Both share the
// guards below; feed-URL entries are namespaced `url:<feedUrl>` so they can't
// collide with a guid in either cache.

import { storage } from './storage';
import type { Episode, Podcast } from './types';

const podcastMem = new Map<string, Podcast | null>();

// The breaker's key and storage medium live in lib/storage.ts with every other
// `bmb:*` key, per CLAUDE.md. These stay as named functions because the call
// sites read as domain vocabulary ("is PI maybe up?") rather than as storage.
export function piMaybeUp(): boolean {
  return storage.piBreaker.isAlive();
}

export function tripPiBreaker() {
  storage.piBreaker.trip();
}

/**
 * Reset the breaker (used after the user explicitly retries).
 *
 * **Drops the negative entries too.** Clearing the flag alone was not a retry:
 * every id the breaker had already answered `null` for stayed `null` in
 * `podcastMem`/`episodeMem` for the life of the tab, so the button cleared the
 * breaker and the screen did not change. Only the nulls go — a resolved entry
 * is still good, and re-fetching hundreds of them would undo the point of the
 * cache.
 */
export function resetPiBreaker() {
  storage.piBreaker.reset();
  for (const [k, v] of podcastMem) if (v === null) podcastMem.delete(k);
  for (const [k, v] of episodeMem) if (v === null) episodeMem.delete(k);
}

/**
 * Shared resolve path behind both public resolvers. `cacheKey` namespaces the
 * memo + localStorage entry; `query` is the already-encoded `/api/by-guid`
 * query string. Misses are cached as null so a guid PI can't resolve is
 * attempted at most once per page.
 */
// "We were refused, so we never asked" — distinct from both "PI is down" and
// "PI says no", and it used to be filed under the last of those.
//
//   429  our OWN rate limiter (lib/rate-limit.ts), not Podcast Index at all
//   408  the request timed out before anything answered
//
// `if (!r.ok)` swallowed both and negative-cached them for the life of the tab,
// under a comment that says "404 IS an answer". A 429 is not an answer about a
// feed; it is this origin declining to look. And it arrives in bursts, because
// favorites hydration is exactly the traffic shape that trips a per-IP limit —
// so the entries poisoned are never one or two, they are whatever half of the
// list ran after the budget ran out.
//
// Deliberately NOT `tripPiBreaker()`. The breaker means "PI is down, stop
// asking for the rest of this tab's life", and firing it over our own limiter
// would turn a delay into a tab-wide outage. Uncached null lets the next page
// load resolve the entry normally.
const COULD_NOT_ASK = new Set([408, 429]);

async function resolveVia(cacheKey: string, query: string): Promise<Podcast | null> {
  if (podcastMem.has(cacheKey)) return podcastMem.get(cacheKey) ?? null;
  const cached = storage.podcastMeta.get(cacheKey);
  if (cached) {
    podcastMem.set(cacheKey, cached);
    return cached;
  }
  // "We didn't ask" — NOT an answer, so nothing is cached. Caching here made
  // resetPiBreaker() unable to recover: the breaker cleared but every entry it
  // had already poisoned stayed null for the life of the tab.
  if (!piMaybeUp()) return null;
  try {
    const r = await fetch(`/api/by-guid?${query}`);
    // 5xx is PI being down, not PI saying no. Trip the breaker and leave the
    // entry UNCACHED so a retry can still resolve it.
    if (r.status >= 500) {
      tripPiBreaker();
      return null;
    }
    // Nothing was asked — leave the entry UNCACHED so a later load can resolve
    // it. See COULD_NOT_ASK above.
    if (COULD_NOT_ASK.has(r.status)) return null;
    // 404 IS an answer: PI has been asked and does not hold this feed. Cache it.
    if (!r.ok) {
      podcastMem.set(cacheKey, null);
      return null;
    }
    const { podcast } = (await r.json()) as { podcast: Podcast };
    if (!podcast) {
      podcastMem.set(cacheKey, null);
      return null;
    }
    podcastMem.set(cacheKey, podcast);
    storage.podcastMeta.set(cacheKey, podcast);
    return podcast;
  } catch {
    // The fetch never completed — offline, aborted, a throttled connection
    // giving up. That is "we could not ask", and caching it as null was this
    // module breaking CLAUDE.md's oldest rule: never record an absence you
    // didn't reliably observe.
    //
    // It bit exactly as predicted. Favorites hydration fans ~100 parallel
    // requests at once; on a slow link many stall, each got negative-cached in
    // a module-level Map that is never invalidated, and those favorites then
    // rendered as blank placeholders with no art or title FOR THE LIFE OF THE
    // TAB — surviving the network recovering, and fixed only by opening a new
    // tab. Leave it unresolved instead so the next attempt retries.
    return null;
  }
}

/**
 * Fill the caches for many identifiers in ONE request, before the per-entry
 * resolvers run.
 *
 * DELIBERATELY A PREFETCH, NOT A REWRITE. `resolveVia` and
 * `resolveEpisodeByGuid` below are untouched: the breaker, COULD_NOT_ASK, and
 * the rule about what may and may not be cached as an absence all keep working
 * exactly as they did. After a warm pass the existing resolvers simply find
 * every entry in `podcastMem` and issue no network calls at all. Every rule in
 * this file cost a production incident; the blast radius of adding speed to it
 * should be as close to zero as it can be made.
 *
 * The problem it solves is a burst, not a latency: favorites hydration issues
 * one request per favorited show and one per favorited track — 213 and 232 on
 * the list this was measured against — drained six at a time because that is
 * what a browser allows per host. That burst is also what exhausts the per-IP
 * limiter, and a 429 arriving mid-list poisons whatever ran after the budget.
 *
 * THE THREE-STATE ANSWER IS WHY THIS CANNOT BE A SIMPLE MAP MERGE:
 *
 *   key present, value   PI resolved it            - cache it
 *   key present, null    PI answered "not found"   - cache it (404 IS an answer)
 *   key ABSENT           we could not ask          - cache NOTHING, retry later
 *
 * Warming is entirely best-effort. Any failure leaves every cache untouched and
 * the ordinary per-entry path runs, so this can never make resolution worse.
 */
export async function warmPodcastCache(guids: string[]): Promise<void> {
  const wanted = Array.from(new Set(guids)).filter((g) => g && !podcastMem.has(g));
  if (!wanted.length || !piMaybeUp()) return;
  for (const chunk of chunked(wanted, BATCH_SIZE)) {
    try {
      const r = await fetch(`/api/by-guid/batch?guids=${chunk.map(encodeURIComponent).join(',')}`);
      // A 5xx is PI being down; the breaker belongs to the resolvers, and
      // tripping it from a prefetch would disable metadata for the whole tab
      // over a warm-up. Just stop warming.
      if (!r.ok) return;
      const { podcasts } = (await r.json()) as { podcasts: Record<string, Podcast | null> };
      if (!podcasts || typeof podcasts !== 'object') return;
      for (const key of chunk) {
        // ABSENT means "we could not ask". `in`, never `?? null` — the latter
        // turns every unanswered guid into a cached miss, which is the exact
        // poisoning COULD_NOT_ASK exists to prevent.
        if (!(key in podcasts)) continue;
        const podcast = podcasts[key];
        podcastMem.set(key, podcast ?? null);
        if (podcast) storage.podcastMeta.set(key, podcast);
      }
    } catch {
      // Offline, aborted, throttled. Nothing observed, so nothing recorded.
      return;
    }
  }
}

/** Same, for `(feedGuid, itemGuid)` pairs. POST because item guids are commonly
 *  permalink URLs, so a hundred pairs do not reliably fit a query string. */
export async function warmEpisodeCache(refs: { feedGuid: string; itemGuid: string }[]): Promise<void> {
  const seen = new Set<string>();
  const wanted = refs.filter((r) => {
    if (!r?.feedGuid || !r?.itemGuid) return false;
    const key = `${r.feedGuid}:${r.itemGuid}`;
    if (seen.has(key) || episodeMem.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!wanted.length || !piMaybeUp()) return;
  for (const chunk of chunked(wanted, BATCH_SIZE)) {
    try {
      const r = await fetch('/api/episode-by-guid/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refs: chunk }),
      });
      if (!r.ok) return;
      const { episodes } = (await r.json()) as { episodes: Record<string, Episode | null> };
      if (!episodes || typeof episodes !== 'object') return;
      for (const ref of chunk) {
        const key = `${ref.feedGuid}:${ref.itemGuid}`;
        if (!(key in episodes)) continue;
        const episode = episodes[key];
        episodeMem.set(key, episode ?? null);
        if (episode) storage.episodeMeta.set(key, episode);
      }
    } catch {
      return;
    }
  }
}

// Matches the server-side MAX_BATCH in lib/pi-batch.ts. A larger chunk is
// silently truncated there, which would look like a partial warm.
const BATCH_SIZE = 100;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function resolvePodcastByGuid(guid: string): Promise<Podcast | null> {
  return resolveVia(guid, `guid=${encodeURIComponent(guid)}`);
}

/**
 * Resolve by RSS feed URL. Used as the podroll fallback when a
 * `<podcast:remoteItem>`'s feedGuid isn't indexed by Podcast Index but the
 * entry carries a feedUrl hint — the same PI-coverage gap that forced the RSS
 * fallback in `resolveValueTimeSplits`.
 */
export function resolvePodcastByFeedUrl(feedUrl: string): Promise<Podcast | null> {
  return resolveVia(`url:${feedUrl}`, `url=${encodeURIComponent(feedUrl)}`);
}

// --- episodes --------------------------------------------------------------
//
// Same four guards for `/api/episode-by-guid`, sharing the breaker with the
// podcast path: a 5xx from either means PI is down for both, and favorites
// hydration fans out over shows and episodes in the same burst.

const episodeMem = new Map<string, Episode | null>();

/**
 * Resolve a favorited episode from its NIP-73 identifier pair. BOTH guids are
 * required — PI can't look an item up without its podcast — so an entry whose
 * parent feed is unknown resolves to null rather than firing a doomed request.
 */
export async function resolveEpisodeByGuid(
  feedGuid: string,
  itemGuid: string,
): Promise<Episode | null> {
  const cacheKey = `${feedGuid}:${itemGuid}`;
  if (episodeMem.has(cacheKey)) return episodeMem.get(cacheKey) ?? null;
  const cached = storage.episodeMeta.get(cacheKey);
  if (cached) {
    episodeMem.set(cacheKey, cached);
    return cached;
  }
  // Not an answer — see resolveVia. Nothing cached.
  if (!piMaybeUp()) return null;
  try {
    const r = await fetch(
      `/api/episode-by-guid?feedGuid=${encodeURIComponent(feedGuid)}&itemGuid=${encodeURIComponent(itemGuid)}`,
    );
    if (r.status >= 500) {
      tripPiBreaker();
      return null;
    }
    // Same rule as resolveVia, and it matters more here: an episode lookup runs
    // once per favorited track, so this is the endpoint a large list exhausts
    // first.
    if (COULD_NOT_ASK.has(r.status)) return null;
    if (!r.ok) {
      episodeMem.set(cacheKey, null);
      return null;
    }
    const { episode } = (await r.json()) as { episode: Episode };
    if (!episode) {
      episodeMem.set(cacheKey, null);
      return null;
    }
    episodeMem.set(cacheKey, episode);
    storage.episodeMeta.set(cacheKey, episode);
    return episode;
  } catch {
    // Transient, not an absence — see resolveVia's catch.
    return null;
  }
}

/**
 * Load a show's feed and pick one episode out of it by guid — the only way to
 * put an episode on screen that this app hasn't already listed.
 *
 * **Not `resolveEpisodeByGuid` above, and the difference is not cosmetic.**
 * That one returns PI's bare indexed record; `/api/feed` is where an episode
 * becomes the object `<EpisodeDetailView>` renders. Only the feed route applies
 * the channel value-block fallback (`e.value ?? podcast.value`, boost invariant
 * 3), and only it carries the RSS-only fields PI indexes none of — the show
 * notes, `<podcast:socialInteract>`, the transcript set, alternate enclosures
 * and the episode's own npubs. Opening a favorite with the bare record would
 * hand the user an episode page whose BOOST button had no recipients and whose
 * boost note p-tagged nobody, which is worse than the show page it replaced.
 *
 * Both halves of the result are wanted. `podcast` is the RSS-enriched show
 * (funding / medium / podroll), for `syncSelectedPodcast`. `episode` is null
 * when the feed loaded but doesn't hold that guid — `/api/feed` asks PI for the
 * latest `PI_EPISODE_MAX` items, so a favorite older than an archive show's
 * first thousand legitimately isn't in it, and the caller should stay on the
 * show page rather than invent one.
 *
 * Returns null only when the feed itself couldn't be loaded. Deliberately does
 * NOT trip the PI breaker: this runs on an explicit navigation, where the cost
 * of a wrong trip is every subsequent metadata resolve in the tab going dark.
 */
export async function loadEpisodeFromFeed(
  feedId: number,
  guid: string,
): Promise<{ podcast: Podcast; episode: Episode | null } | null> {
  try {
    const res = await fetch(`/api/feed?id=${feedId}`);
    const data = await res.json();
    if (!data?.podcast) return null;
    const episodes = Array.isArray(data.episodes) ? (data.episodes as Episode[]) : [];
    return { podcast: data.podcast as Podcast, episode: episodes.find((e) => e.guid === guid) ?? null };
  } catch {
    return null;
  }
}
