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
import { resolveItemValueFromRss } from './musicl-resolver';
import { askIndex } from './nostr-index-server';
import { hasValueRecipients, probeThenBatch } from './util';

/** Hard cap on identifiers per request. An attacker-chosen list length must
 *  never turn one request into an unbounded PI fan-out. The per-request
 *  CONCURRENCY ceiling is `PI_FANOUT`, beside `probeThenBatch` in lib/util.ts
 *  — this bounds how many are asked for, that bounds how many at once, and
 *  shipping only the first is what made a 231-track list resolve four. */
export const MAX_BATCH = 100;
import type { Episode, Podcast } from './types';


export async function batchPodcasts(guids: string[]): Promise<Record<string, Podcast | null>> {
  const wanted = guids.slice(0, MAX_BATCH);
  const out: Record<string, Podcast | null> = {};
  if (!wanted.length) return out;

  // The index answers most of these from one round trip and its own warm-fill.
  //
  // **`unknown`, and NORMALIZED — never `Podcast` by generic parameter.** The
  // index caches Podcast Index's RAW record, so what comes back is PI's shape,
  // not ours. Declaring it `Podcast` type-checks and is wrong in every field
  // `buildPodcast` derives: `value` above all, because PI writes
  // `{ model, destinations }` and `hasValueRecipients` reads `.recipients` —
  // so `fillTrackValues`' stage 1 tested FALSE for every album the index
  // answered, pushing every row into the RSS stage, which is capped at
  // MAX_TRACK_VALUE_FEEDS. Playlist tracks past that cap kept a dead BOOST
  // button, and only when the index was configured and warm.
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

/**
 * Album feeds one page may READ over RSS to recover a value block.
 *
 * The PI stage below answers most rows for free, so this is the tail. It is a
 * ceiling on distinct FEEDS rather than on rows because the rows of one album
 * share a single fetch (`fetchFeedXml` caches by URL for five minutes), and it
 * exists because a page is up to `MAX_BATCH` rows whose feeds are attacker-
 * chosen — the curator writes the list.
 */
const MAX_TRACK_VALUE_FEEDS = 16;

/**
 * Fill in the value block for tracks Podcast Index resolved WITHOUT one.
 *
 * **A playlist row is the only reason this exists, and without it the row's
 * BOOST button is dead.** A `<podcast:remoteItem>` names an item in somebody
 * else's feed, so `/api/playlist` resolves each row through `/episodes/byguid`
 * and nothing else — and PI's episode record carries a `value` only when the
 * item declares one of its own. Most music feeds declare `<podcast:value>` once,
 * on the CHANNEL, and let every track inherit it. So the block exists, the
 * artist is payable, and the track arrives here with `value: null`.
 *
 * The container cannot stand in for it: a playlist's own block belongs to the
 * curator (see `payableValue` in lib/util.ts). Resolving the ALBUM's is the
 * only correct answer, and it has to happen server-side — the guids never reach
 * the browser.
 *
 * TWO stages, cheapest first:
 *
 *   1. `batchPodcasts` over the DISTINCT parent feeds. PI's feed record carries
 *      the channel-level block, which is the same source `/api/feed` already
 *      trusts for every ordinary show's fallback, and the read index answers
 *      most of it in one round trip. No RSS at all.
 *   2. For what is left, read the album feed itself — item block first, then
 *      channel — capped at `MAX_TRACK_VALUE_FEEDS` distinct feeds. This covers
 *      an album PI holds without a parsed value block, which is the case
 *      `resolveOneSplit` has always fallen back for.
 *
 * Rows are matched to their parent by `episode.podcastGuid` (PI's answer for
 * which feed the item actually lives in), never by the playlist's own
 * `feedGuid`, which may name a publisher feed.
 *
 * Returns a NEW array; unresolved placeholder rows are passed through
 * untouched, since a row with no enclosure has nothing to boost.
 *
 * **`unasked` is the three-state contract reaching the value block**, and the
 * caller's cache header has to read it. A row whose album Podcast Index
 * ANSWERED about — with a feed holding no value block — is a real, cacheable
 * "this track has no splits". A row whose album we could not ask about, because
 * the probe found PI unreachable, is not an answer at all: cached, it freezes a
 * dead BOOST button into the CDN for the window and the reader's retry re-serves
 * it.
 *
 * **`capped` is reported SEPARATELY, and the difference is whether a retry could
 * ever answer differently.** Both counters describe a row this pass left
 * unvalued, so one number for the two reads as an economy — and it cost every
 * long playlist its cache. `unasked` is transient: PI was unreachable this
 * second and may answer the next, so the page must not be stored. `capped` is
 * this module's OWN ceiling (`MAX_TRACK_VALUE_FEEDS`) applied to a fixed list of
 * refs in a fixed order, so the same request yields the same rows every time —
 * there is nothing for a retry to discover, and refusing to cache it only makes
 * every reader in the window pay the whole page again. A page whose tracks span
 * more than sixteen albums is the ordinary case for a greatest-hits playlist,
 * which is how a `no-store` written for an outage came to apply to a healthy
 * response.
 */
export interface FilledTrackValues {
  episodes: Episode[];
  /** Rows left unvalued because we could not ask, never because PI said no. */
  unasked: number;
  /** Rows left unvalued because their album was past `MAX_TRACK_VALUE_FEEDS`. */
  capped: number;
}

export async function fillTrackValues(episodes: Episode[]): Promise<FilledTrackValues> {
  interface Pending { index: number; feedGuid: string; itemGuid: string }
  const pending: Pending[] = [];
  episodes.forEach((e, index) => {
    if (e.unresolved || hasValueRecipients(e.value)) return;
    if (!e.podcastGuid || !e.guid) return;
    pending.push({ index, feedGuid: e.podcastGuid, itemGuid: e.guid });
  });
  if (!pending.length) return { episodes, unasked: 0, capped: 0 };

  const out = [...episodes];
  let unasked = 0;
  let capped = 0;
  const albums = await batchPodcasts([...new Set(pending.map((p) => p.feedGuid))]);

  // ── Stage 2's work list, built while stage 1 runs over the same rows ──────
  // Keyed by feed URL so the rows of one album share one fetch.
  const byFeedUrl = new Map<string, Pending[]>();
  for (const p of pending) {
    // `in`, not truthiness: batchPodcasts leaves a key ABSENT when it could not
    // ask and holds null when PI answered "not found". Both leave the row
    // unvalued and its BOOST off, which is what the page already looked like —
    // but only the first is a gap, and reading them the same way is what makes
    // a rate limit cacheable as "this track has no splits".
    if (!(p.feedGuid in albums)) { unasked++; continue; }
    const album = albums[p.feedGuid];
    if (hasValueRecipients(album?.value)) {
      out[p.index] = { ...out[p.index], value: album!.value };
      continue;
    }
    const url = album?.url;
    // PI answered and holds no feed URL to read: that is an answer, not a gap.
    if (!url) continue;
    const rows = byFeedUrl.get(url);
    if (rows) rows.push(p);
    else byFeedUrl.set(url, [p]);
  }
  if (!byFeedUrl.size) return { episodes: out, unasked, capped };

  const feedUrls = [...byFeedUrl.keys()];
  const searched = feedUrls.slice(0, MAX_TRACK_VALUE_FEEDS);
  if (feedUrls.length > searched.length) {
    for (const url of feedUrls.slice(MAX_TRACK_VALUE_FEEDS)) {
      // `capped`, not `unasked` — see FilledTrackValues. This ceiling is ours
      // and it is deterministic, so the row is as settled as the pass can make
      // it; an outage is the other counter.
      capped += byFeedUrl.get(url)!.length;
    }
    // Say what was dropped. Silently searching part of a page reads as "these
    // tracks have no value block", which is the same thing on screen as a
    // track whose artist really did not publish one.
    console.warn(
      `[playlist] ${feedUrls.length} album feeds still need a value block;`
      + ` reading the first ${MAX_TRACK_VALUE_FEEDS}`,
    );
  }

  await Promise.allSettled(searched.map(async (url) => {
    // Sequential WITHIN one feed on purpose: the first call fetches the RSS and
    // the rest are cache hits. Firing them together would open one outbound
    // request per track against the same URL, which is what the cache exists to
    // prevent.
    for (const p of byFeedUrl.get(url)!) {
      const value = await resolveItemValueFromRss(url, p.itemGuid);
      if (hasValueRecipients(value)) out[p.index] = { ...out[p.index], value };
    }
  }));

  return { episodes: out, unasked, capped };
}
