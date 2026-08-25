// Server-side batch resolution for Podcast Index identifiers, shared by
// /api/by-guid/batch and /api/episode-by-guid/batch.
//
// SERVER-ONLY (it imports lib/pi.ts, which reads process.env).
//
// THE THREE-STATE ANSWER IS THE WHOLE CONTRACT, and it is why this is a shared
// helper rather than two copies:
//
//   key present, value   PI resolved it            — the client may cache it
//   key present, null    PI answered "not found"   — the client may cache it
//   key ABSENT           we could not ask          — the client must NOT cache
//
// Collapsing the third into the second is the negative-cache poisoning bug
// lib/podcast-meta.ts's COULD_NOT_ASK set exists to prevent. Two independent
// copies of that rule is one copy that eventually forgets it.

import { getEpisodeByGuid, getPodcastByFeedUrl, getPodcastByGuid } from './pi';
import { askIndex } from './nostr-index-server';
import type { Episode, Podcast } from './types';

/** Hard cap on identifiers per request. An attacker-chosen list length must
 *  never turn one request into an unbounded PI fan-out. */
export const MAX_BATCH = 100;

// Probe-first-then-batch, the same shape lib/nostr/favorites-hydrator.ts and
// /api/publisher already use: one sequential lookup first, and if PI is down
// the remaining N-1 are never attempted. One outage costs one failure rather
// than N, and those N are left ABSENT — which is exactly "we could not ask".
async function probeThenBatch<T, R>(
  items: T[],
  resolve: (item: T) => Promise<R | null>,
  key: (item: T) => string,
  out: Record<string, R | null>,
): Promise<void> {
  if (!items.length) return;
  const [first, ...rest] = items;
  // Deliberately UNCAUGHT for the probe's own failure: getPodcast*/getEpisode*
  // already turn PI's 400/404 "not found" into null, so a throw here means PI
  // itself is unreachable. Bail and leave every key absent.
  try {
    out[key(first)] = await resolve(first);
  } catch {
    return;
  }
  const settled = await Promise.allSettled(rest.map(resolve));
  settled.forEach((r, i) => {
    // A rejection is "could not ask": leave the key absent rather than
    // recording an absence we did not observe.
    if (r.status === 'fulfilled') out[key(rest[i])] = r.value;
  });
}

export async function batchPodcasts(guids: string[]): Promise<Record<string, Podcast | null>> {
  const wanted = guids.slice(0, MAX_BATCH);
  const out: Record<string, Podcast | null> = {};
  if (!wanted.length) return out;

  // The index answers most of these from one round trip and its own warm-fill.
  const fromIndex = await askIndex<Record<string, Podcast | null>>('/pi/podcasts', {
    method: 'POST',
    body: { guids: wanted },
  });
  // A key the index omitted is one IT could not answer — carry that meaning
  // through rather than treating an absent key as null.
  if (fromIndex) for (const [k, v] of Object.entries(fromIndex)) out[k] = v ?? null;

  const missing = wanted.filter((g) => !(g in out));
  await probeThenBatch(
    missing,
    (g) => (g.startsWith('url:') ? getPodcastByFeedUrl(g.slice(4)) : getPodcastByGuid(g)),
    (g) => g,
    out,
  );
  return out;
}

export interface EpisodeRef { feedGuid: string; itemGuid: string }

export function episodeKey(r: EpisodeRef): string {
  return `${r.feedGuid}:${r.itemGuid}`;
}

export async function batchEpisodes(refs: EpisodeRef[]): Promise<Record<string, Episode | null>> {
  const wanted = refs.slice(0, MAX_BATCH);
  const out: Record<string, Episode | null> = {};
  if (!wanted.length) return out;

  const fromIndex = await askIndex<Record<string, Episode | null>>('/pi/episodes', {
    method: 'POST',
    body: { refs: wanted },
  });
  if (fromIndex) for (const [k, v] of Object.entries(fromIndex)) out[k] = v ?? null;

  const missing = wanted.filter((r) => !(episodeKey(r) in out));
  await probeThenBatch(missing, (r) => getEpisodeByGuid(r.feedGuid, r.itemGuid), episodeKey, out);
  return out;
}
