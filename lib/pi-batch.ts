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

import {
  getEpisodeByGuid, getPodcastByFeedUrl, getPodcastByGuid,
  episodeFromPiRecord, podcastFromPiFeed,
} from './pi';
import { askIndex } from './nostr-index-server';
import { probeThenBatch, withFeedMediums } from './util';

/** Hard cap on identifiers per request. An attacker-chosen list length must
 *  never turn one request into an unbounded PI fan-out. The per-request
 *  CONCURRENCY ceiling is `PI_FANOUT`, beside `probeThenBatch` in lib/util.ts
 *  — this bounds how many are asked for, that bounds how many at once, and
 *  shipping only the first is what made a 231-track list resolve four. */
export const MAX_BATCH = 100;
import type { Episode, Podcast, ValueTimeSplit } from './types';


export async function batchPodcasts(guids: string[]): Promise<Record<string, Podcast | null>> {
  const wanted = guids.slice(0, MAX_BATCH);
  const out: Record<string, Podcast | null> = {};
  if (!wanted.length) return out;

  // The index answers most of these from one round trip and its own warm-fill.
  //
  // **`unknown`, and NORMALIZED — never `Podcast` by generic parameter.** The
  // index caches Podcast Index's RAW record, so what comes back is PI's shape,
  // not ours. Declaring it `Podcast` type-checks and is wrong in every field
  // `buildPodcast` derives, and it would carry PI's `value` block straight past
  // the rule that only an RSS document names a payee.
  const fromIndex = await askIndex<Record<string, unknown>>('/pi/podcasts', {
    method: 'POST',
    body: { guids: wanted },
  });
  // A key the index omitted is one IT could not answer — carry that meaning
  // through rather than treating an absent key as null.
  //
  // A record that fails to normalize is left ABSENT rather than recorded as
  // null, for the same reason: null here means "PI says there is none", and a
  // cache entry we could not read is not that. Leaving it absent sends it to
  // `probeThenBatch` below, which asks PI properly.
  if (fromIndex) {
    for (const [k, v] of Object.entries(fromIndex)) {
      if (v == null) { out[k] = null; continue; }
      const podcast = podcastFromPiFeed(v);
      if (podcast) out[k] = podcast;
    }
  }

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

/**
 * Each marker with its remote feed's own medium beside it, for `musicHoldSpans`.
 * Podcast Index carries `medium` on the FEED record, never on the episode, so it
 * is a separate lookup over the distinct feeds, through the batch door.
 *
 * **It never throws and never loses a marker.** These markers decide who a boost
 * pays, and a song's speed is not worth one of them: on any failure the list comes
 * back as it went in, and the player uses its fallback rule.
 *
 * After `resolveValueTimeSplits`, not beside it, so the request stays inside one
 * `PI_FANOUT`.
 */
export async function withRemoteFeedMediums(splits: ValueTimeSplit[]): Promise<ValueTimeSplit[]> {
  const guids = [...new Set(splits.map((s) => s.remoteItem?.feedGuid).filter((g): g is string => !!g))];
  if (!guids.length) return splits;
  try {
    return withFeedMediums(splits, await batchPodcasts(guids));
  } catch {
    return splits;
  }
}

export function episodeKey(r: EpisodeRef): string {
  return `${r.feedGuid}:${r.itemGuid}`;
}

export async function batchEpisodes(refs: EpisodeRef[]): Promise<Record<string, Episode | null>> {
  const wanted = refs.slice(0, MAX_BATCH);
  const out: Record<string, Episode | null> = {};
  if (!wanted.length) return out;

  // Raw PI records, normalized — see the long note in `batchPodcasts`. For an
  // episode the un-normalized fields also include `valueTimeSplits` (PI names
  // the field `timesplits`), `transcriptUrl` and `socialInteract`, so an index
  // answer silently carried no per-track splits, no transcript and no
  // discussion thread.
  const fromIndex = await askIndex<Record<string, unknown>>('/pi/episodes', {
    method: 'POST',
    body: { refs: wanted },
  });
  if (fromIndex) {
    for (const [k, v] of Object.entries(fromIndex)) {
      if (v == null) { out[k] = null; continue; }
      const episode = episodeFromPiRecord(v);
      if (episode) out[k] = episode;
    }
  }

  const missing = wanted.filter((r) => !(episodeKey(r) in out));
  await probeThenBatch(missing, (r) => getEpisodeByGuid(r.feedGuid, r.itemGuid), episodeKey, out);
  return out;
}
