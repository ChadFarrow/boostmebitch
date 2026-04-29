'use client';

// Unified `/api/by-guid` resolver used by anything that needs a Podcast
// from a podcast:guid identifier (favorites hydrator, global Nostr feed,
// per-podcast feed). Layers four guards so the endpoint isn't hammered
// when Podcast Index is unconfigured locally:
//
//   1. In-memory Map (fastest path within a page session).
//   2. localStorage `bmb:pmeta:<guid>` cache (7-day TTL, survives reloads).
//   3. sessionStorage circuit breaker — once /api/by-guid 5xxs in this tab,
//      every subsequent caller short-circuits to null without a fetch.
//   4. The actual fetch.
//
// Callers using the breaker manually (e.g. probe-first batch patterns)
// can call `piMaybeUp()` before firing parallel resolves.

import { storage } from './storage';
import type { Podcast } from './types';

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

export async function resolvePodcastByGuid(guid: string): Promise<Podcast | null> {
  if (podcastMem.has(guid)) return podcastMem.get(guid) ?? null;
  const cached = storage.podcastMeta.get(guid);
  if (cached) {
    podcastMem.set(guid, cached);
    return cached;
  }
  if (!piMaybeUp()) {
    podcastMem.set(guid, null);
    return null;
  }
  try {
    const r = await fetch(`/api/by-guid?guid=${encodeURIComponent(guid)}`);
    if (r.status >= 500) {
      tripPiBreaker();
      podcastMem.set(guid, null);
      return null;
    }
    if (!r.ok) {
      podcastMem.set(guid, null);
      return null;
    }
    const { podcast } = (await r.json()) as { podcast: Podcast };
    if (!podcast) {
      podcastMem.set(guid, null);
      return null;
    }
    podcastMem.set(guid, podcast);
    storage.podcastMeta.set(guid, podcast);
    return podcast;
  } catch {
    podcastMem.set(guid, null);
    return null;
  }
}
