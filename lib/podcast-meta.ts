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

const PI_BREAKER_KEY = 'bmb:pi:dead';

const podcastMem = new Map<string, Podcast | null>();

export function piMaybeUp(): boolean {
  if (typeof window === 'undefined') return true;
  try { return sessionStorage.getItem(PI_BREAKER_KEY) !== '1'; } catch { return true; }
}

export function tripPiBreaker() {
  if (typeof window === 'undefined') return;
  try { sessionStorage.setItem(PI_BREAKER_KEY, '1'); } catch {}
}

/** Reset the breaker (used after the user explicitly retries). */
export function resetPiBreaker() {
  if (typeof window === 'undefined') return;
  try { sessionStorage.removeItem(PI_BREAKER_KEY); } catch {}
}

/**
 * Shared resolve path behind both public resolvers. `cacheKey` namespaces the
 * memo + localStorage entry; `query` is the already-encoded `/api/by-guid`
 * query string. Misses are cached as null so a guid PI can't resolve is
 * attempted at most once per page.
 */
async function resolveVia(cacheKey: string, query: string): Promise<Podcast | null> {
  if (podcastMem.has(cacheKey)) return podcastMem.get(cacheKey) ?? null;
  const cached = storage.podcastMeta.get(cacheKey);
  if (cached) {
    podcastMem.set(cacheKey, cached);
    return cached;
  }
  if (!piMaybeUp()) {
    podcastMem.set(cacheKey, null);
    return null;
  }
  try {
    const r = await fetch(`/api/by-guid?${query}`);
    if (r.status >= 500) {
      tripPiBreaker();
      podcastMem.set(cacheKey, null);
      return null;
    }
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
    podcastMem.set(cacheKey, null);
    return null;
  }
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
  if (!piMaybeUp()) {
    episodeMem.set(cacheKey, null);
    return null;
  }
  try {
    const r = await fetch(
      `/api/episode-by-guid?feedGuid=${encodeURIComponent(feedGuid)}&itemGuid=${encodeURIComponent(itemGuid)}`,
    );
    if (r.status >= 500) {
      tripPiBreaker();
      episodeMem.set(cacheKey, null);
      return null;
    }
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
    episodeMem.set(cacheKey, null);
    return null;
  }
}
