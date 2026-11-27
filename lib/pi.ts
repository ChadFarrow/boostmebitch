// Server-side Podcast Index client. Never import from a client component.
import crypto from 'node:crypto';
import { PiHttpError, isPiMiss } from './pi-error';
import type { ItemPayment, MovedAnswer, Podcast, Episode, ValueBlock, ValueRecipient, ValueTimeSplit, ValueTimeSplitRemoteItem, SocialInteract, PodrollItem, FundingLink, AlternateEnclosure, FeedNpub } from './types';
import {
  readAttr,
  decodeXmlText,
  decodeXmlEntities,
  channelSlice,
  parseFeedNpubs,
  parsePlaylistRemoteItems,
  parsePlaylistSourceFeed,
  type PlaylistItemRef,
  findTags,
  firstTag,
  findBlocks,
  firstBlock,
  extractText,
  stripBlocks,
  stripComments,
  splitAnchors,
  escapeDanglingLt,
  parsePublisherRef,
  remoteItemFeedGuids,
  feedHasValueTag,
  newestItemImage,
  parseItemEnclosure,
  liveReadDocument,
  LIVE_ITEM_TAG,
} from './feed-xml';
import { resolveRemoteItemFromRss } from './musicl-resolver';
import { safeFetch } from './safe-fetch';
import { readCappedText, readPrefixThenScan, MAX_BODY_BYTES } from './capped-body';
import { escapeHtmlAttr, safeUrlAttr } from './safe-url-attr';
import { fnvHash, httpUrl, compareEpisodeOrder, listedTrackGuids, splitOnBareUrls, isPlaylistMedium, matchPlaylistsByQuery, liveBroadcastIsOver, liveStampSecs, piLiveStatus, PLAYLIST_MEDIUMS, mapLimit, PI_FANOUT, PI_FEED_IDS_MAX, episodeWithoutValue, FEED_FANOUT, feedUrlsMatchBarWhitespace } from './util';
import { createBoundedCache } from './bounded-cache';
import { BRAND } from './brand';
import { closedService, movedCandidates, pickLiveTwin } from './moved-feeds';
import { confirmValueMissing, demuCopiesToHide, demuCopyCandidates, demuRosterFromPi, demuValueGaps, hasValueBlock, keepForDemu, mspFeedGuids, withCoverFallback } from './demu';
import { DEMU_HIDE_AUTHORS, DEMU_HIDE_LIST, HOMEGROWN_HITS_FEED_URL } from './demu-hide-list';
import type { DemuAlbum, PiMusicRow } from './demu';

const BASE = 'https://api.podcastindex.org/api/1.0';

/**
 * Deadline for one Podcast Index call.
 *
 * Every other outbound fetch in this app carries one — `fetchFeedXml` below is
 * 8 s, `askIndex` and the art/chapter/transcript proxies each set their own —
 * and this one, the call the whole app is built on, had none. `fetch` has no
 * default timeout, so a PI instance that accepted the connection and then went
 * quiet held the request open until the PLATFORM killed it: on Vercel that is
 * the function's whole duration budget, spent on one hung socket, with the
 * reader watching a spinner the entire time. Routes that fan out make it worse
 * — `/api/by-guid/batch` and `/api/publisher` issue several of these, so one
 * silent upstream stalls a request that had nothing else left to do.
 *
 * 8 s matches `fetchFeedXml`. It is deliberately generous: PI's search endpoint
 * is genuinely slow on a cold query, and cutting a slow-but-alive answer short
 * would trade a rare hang for a common failure.
 *
 * A timeout throws (an `AbortError`, not a `PiHttpError`), so it reaches the
 * route as a 500 and trips the client-side breaker. That is the correct
 * reading: an upstream that will not answer is an outage, which is exactly what
 * the breaker exists to notice. It is NOT a "PI does not hold this feed", so it
 * must never be swallowed by the `PiHttpError` 400/404 miss branch — and it
 * isn't, because that branch tests the class.
 */
const PI_TIMEOUT_MS = 8000;

export function authHeaders() {
  const key = process.env.PODCAST_INDEX_KEY;
  const secret = process.env.PODCAST_INDEX_SECRET;
  if (!key || !secret) {
    throw new Error('Missing PODCAST_INDEX_KEY / PODCAST_INDEX_SECRET');
  }
  const ts = Math.floor(Date.now() / 1000).toString();
  const hash = crypto.createHash('sha1').update(key + secret + ts).digest('hex');
  return {
    'X-Auth-Key': key,
    'X-Auth-Date': ts,
    'Authorization': hash,
    'User-Agent': process.env.APP_NAME ?? BRAND.userAgent,
  };
}

/** Thrown by `pi()` on a non-2xx, carrying the status so callers can tell a
 *  "PI doesn't know this" miss from a genuine outage. */
export { PiHttpError } from './pi-error';

async function pi<T>(path: string, maxBytes?: number): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: authHeaders(),
    // NOT Next's data cache. Its key includes every request header, and
    // `authHeaders()` changes `X-Auth-Date` and `Authorization` each second, so
    // a `revalidate` here only ever WROTE entries nobody would read again.
    // Caching happens at the route (`Cache-Control`) and in the client.
    cache: 'no-store',
    // See PI_TIMEOUT_MS. This caps how LONG the call runs; `readCappedText`
    // below caps how MANY BYTES it returns. Neither substitutes for the other.
    signal: AbortSignal.timeout(PI_TIMEOUT_MS),
  });
  // PI is a trusted upstream (hardcoded BASE), so this is about not letting a
  // bad day there become an OOM here rather than about a hostile body. The
  // error branch is capped hardest: that string ends up inside an exception
  // message, so an HTML error page would otherwise ride along in memory and,
  // before the api-handler change, out to the caller.
  //
  // `maxBytes` is for the one caller that asks for a list whose length it
  // chose: a body over the cap THROWS, and a throw here is a 500 on the whole
  // show page, so a request big enough to outgrow the shared ceiling has to
  // raise it rather than inherit it.
  //
  // **The `.catch` is load-bearing: without it the cap defeats the exception it
  // was meant to trim.** `readCappedText` THROWS past its ceiling rather than
  // truncating, and that throw happens while evaluating the argument to
  // `PiHttpError` — so the status never reaches a `PiHttpError` at all and a
  // plain `Error` propagates instead. PI answers a rate limit with a ~7 KB
  // Cloudflare HTML page, comfortably over 4 KB, so EVERY 429 arrived at
  // `lib/api-handler.ts` as an unhandled throw and went out as a 500. Measured
  // 2026-08-29: `/api/search`, `/api/publisher` and `/api/playlist` all failing
  // together with `response too large (exceeded 4096 bytes)` as the only clue,
  // which reads as an app bug rather than as "you are rate limited".
  //
  // Losing the status is not cosmetic. `getPodcastByFeedUrl` and every sibling
  // wrapper turn a 400/404 into a MISS with `isPiMiss`, which tests the class,
  // and `piCouldNotAskStatus` (lib/pi-error.ts) reads 429/408 off the same
  // class so `withErrorHandling` can answer with that status instead of 500.
  // THAT is what puts a PI rate limit into `lib/podcast-meta.ts`'s
  // COULD_NOT_ASK bucket — an uncached null that deliberately does not trip the
  // client-side breaker.
  //
  // **Naming the chain because an earlier version of this comment skipped the
  // middle of it** and claimed podcast-meta already filed a PI 429 under
  // COULD_NOT_ASK. It did not: podcast-meta's own comment says its 429 arm is
  // `lib/rate-limit.ts` — OUR limiter — "not Podcast Index at all". PI's 429
  // rethrows out of the wrapper, `withErrorHandling` made it a 500, and 500 is
  // what trips the breaker. So restoring this class was necessary and was not
  // sufficient; the api-handler mapping is the other half.
  //
  // An empty detail string is the right fallback: the status carries the
  // meaning, the body is a courtesy.
  if (!res.ok) {
    throw new PiHttpError(res.status, await readCappedText(res, 4 * 1024).catch(() => ''));
  }
  return JSON.parse(await readCappedText(res, maxBytes)) as T;
}

// PI's value object → our ValueBlock
/**
 * A positive finite number, or `undefined`.
 *
 * Both sources of `enclosureLength` lie in the same two ways: RSS gives a string
 * attribute (`length="161886720"`), routinely `"0"` or absent, and Podcast Index
 * mirrors whatever the feed said including the zero. `Number('')` is 0 and
 * `Number(undefined)` is NaN, so a bare `Number()` turns both into a size, and a
 * size of 0 would be shown to the listener as "0 MB" beside a 160 MB file.
 */
function numOrUndef(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// One canonical mapping from PI feed shape → our Podcast type. Used by every
// fetch endpoint so a new field is added in one place.
/**
 * Whether Podcast Index lists a value block for this show, for the ⚡ V4V stamp.
 * The ONE read of PI's `value`, and it answers with a boolean so that no payee can
 * leave here. PI writes `{ model, destinations }`; a record the read index normalized
 * carries `recipients`.
 */
function piListsValue(f: any): boolean {
  const block = f?.value;
  return !!(block?.destinations?.length || block?.recipients?.length);
}

function buildPodcast(f: any): Podcast {
  return {
    id: f.id,
    podcastGuid: f.podcastGuid,
    itunesId: typeof f.itunesId === 'number' ? f.itunesId : undefined,
    title: f.title,
    author: f.author,
    description: f.description,
    // `|| undefined` on the tail, not just between the two: PI returns "" for
    // an absent field rather than omitting it, so without this `image` is `""`
    // while its type says `string | undefined`. Every `??` downstream then reads
    // the empty string as a real value and stops falling through — which is how
    // a chapter-art fallback chain silently did nothing on exactly the items
    // that had no art. Same guard the neighbouring `link`/`chaptersUrl` fields
    // already carry.
    image: f.image || f.artwork || undefined,
    // Keep `artwork` separate so the renderer can try it if `image` 404s —
    // PI maps RSS <image><url> to `image` and <itunes:image> to `artwork`,
    // and the two often disagree (Homegrown Hits has a dead bowlafterbowl
    // <image> but a working <itunes:image>).
    artwork: f.artwork && f.artwork !== f.image ? f.artwork : undefined,
    url: f.url,
    medium: typeof f.medium === 'string' && f.medium.length > 0 ? f.medium : undefined,
    // Read by the DEMU search lane (`isDemuFeed`): "not Wavlake" is a test on
    // this field, never on the host. PI sends "" for a feed without one, and
    // the "" is KEPT: `isDemuFeed` passes a blank generator and fails an
    // absent one, so turning "" into `undefined` here would hide every DeMu
    // feed that has no generator (190 of 1,163 on 2026-11-15).
    generator: typeof f.generator === 'string' ? f.generator : undefined,
    v4vHint: piListsValue(f) || undefined,
    funding: fundingFromPi(f),
  };
}

// A PI lookup miss is NOT always an HTTP error. For a feed PI knows about but
// has never crawled, `/podcasts/byfeedurl` answers **200** with
// `{"status":"true","feed":[],"description":"This feed has no meta-data yet."}`
// — and `[]` is truthy, so a bare `data.feed ? …` check treated the empty array
// as a hit and handed it to `buildPodcast`, which happily produced a Podcast
// with every field `undefined`. Symptom: pasting such a feed's URL into search
// rendered one blank result row, and the RSS-preview fallback in
// `app/api/search/route.ts` (which only runs on a null) never got its turn.
// Normalize array/object and require an `id` — every real PI feed carries one.
export function podcastFromPiFeed(f: any): Podcast | null {
  const feed = Array.isArray(f) ? f[0] : f;
  if (!feed || feed.id == null) return null;
  return buildPodcast(feed);
}

/**
 * A raw Podcast Index EPISODE record → our `Episode`, or null if unusable.
 *
 * The counterpart to {@link podcastFromPiFeed}, exported for the same reason:
 * `services/nostr-index` caches **Podcast Index's raw answer**, and whatever
 * reads that cache has to normalize it exactly as the direct PI path does.
 *
 * **The two paths had drifted, and it was not visible from either side.** The
 * index stores `d.episode` verbatim and `/pi/episodes` returns it; `lib/
 * pi-batch.ts` then declared the result `Episode` with a bare generic
 * parameter, which type-checks and is wrong in every field this builder
 * derives. `value` is the one that costs money: PI sends
 * `{ model, destinations }`, `hasValueRecipients` reads `.recipients`, so
 * every album the index answered for tested as having NO splits.
 * `transcriptUrl`,
 * `socialInteract`, `season` and the `image`/`artwork` fallbacks were all
 * simply absent. None of it reproduces locally, because it needs the index to
 * be configured AND warm.
 */
export function episodeFromPiRecord(e: any): Episode | null {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  // Same `id` test `podcastFromPiFeed` makes: every real PI record carries one,
  // and its absence is how a `{}` or a placeholder is told from an answer.
  if (e.id == null) return null;
  return buildEpisode(e);
}

export async function searchPodcasts(query: string, max = 20): Promise<Podcast[]> {
  const data = await pi<any>(
    `/search/byterm?q=${encodeURIComponent(query)}&max=${max}&fulltext`,
  );
  return (data.feeds ?? []).map(buildPodcast);
}

/**
 * Podcast Index's own keyword search, restricted to feeds it holds as MUSIC.
 *
 * The point of a separate endpoint is that `/search/byterm` has no medium
 * parameter, so narrowing its 50 ranked rows client-side cannot reach an album
 * it ranked at position 60 — and an absent row reads as "the index does not have
 * this record", which is the failure the playlist lane already exists to fix.
 * This asks the index the question directly instead.
 *
 * **A miss here is never an outage**, exactly as in `getFeedsByMedium` below and
 * for the same reason: an index that will not serve this path is
 * indistinguishable, from the caller's side, from one holding no music for the
 * term. Both answer `[]`, `/api/search` falls back to filtering byterm's rows,
 * and the MUSIC chip degrades to a shorter answer rather than a broken one. Only
 * auth and 5xx propagate.
 */
export async function searchMusicPodcasts(query: string, max = 50): Promise<Podcast[]> {
  try {
    const data = await pi<any>(
      `/search/music/byterm?q=${encodeURIComponent(query)}&max=${max}&fulltext`,
    );
    return (data.feeds ?? []).map(buildPodcast);
  } catch (e) {
    if (isPiMiss(e)) return [];
    throw e;
  }
}

/**
 * Every feed Podcast Index holds for one `podcast:medium` value.
 *
 * **A miss here is never an outage.** PI's own API documentation enumerates only
 * the seven BASE mediums for this parameter — the `L` list variants are not in
 * it — so a request for `musicL` may legitimately be refused by an index that
 * has simply never been asked for one. That is indistinguishable from a medium
 * nobody publishes, and both mean the same thing to the caller: no playlists of
 * this kind. So a 400 answers `[]`, and only auth and 5xx propagate, exactly as
 * `getPodcastByFeedUrl` treats a feed it does not hold.
 */
async function getFeedsByMedium(medium: string, max: number): Promise<Podcast[]> {
  try {
    const data = await pi<any>(
      `/podcasts/bymedium?medium=${encodeURIComponent(medium)}&max=${max}`,
    );
    return (data.feeds ?? []).map(buildPodcast);
  } catch (e) {
    if (isPiMiss(e)) return [];
    throw e;
  }
}

/**
 * How long the playlist roster is servable at all, and how long it is FRESH.
 *
 * A list feed is a rare and slow-moving thing — the whole point of the roster is
 * that there are few enough of them to hold — so a long window costs nothing and
 * keeps a fan-out of one request per list medium off PI on every search. The
 * stale window exists so a refresh failure serves the last good roster rather
 * than dropping the lane, the same two-tier shape `rssXmlCache` uses.
 */
const PLAYLIST_ROSTER_FRESH_MS = 6 * 60 * 60_000;
const PLAYLIST_ROSTER_STALE_MS = 24 * 60 * 60_000;
/** Per medium. List feeds are rare; this is far above any plausible count. */
const PLAYLIST_ROSTER_MAX = 1000;
/**
 * How long a search will wait on a COLD roster before going without the lane.
 *
 * The whole roster is ten small parallel requests, most of which are a 400 for a
 * medium the index does not carry, so a healthy Podcast Index is far inside
 * this. It is a ceiling on the worst case, not a budget anyone should be
 * spending: past it the search proceeds without playlists and the refresh keeps
 * running for the next one.
 */
const ROSTER_COLD_WAIT_MS = 1500;

// ONE entry, but through the shared bounded cache anyway: the horizon and the
// cap are what stop a module-level cache of fetched content growing forever,
// and writing "it is only one key" is how the next one acquires a second.
const playlistRoster = createBoundedCache<Podcast[]>({
  maxAgeMs: PLAYLIST_ROSTER_STALE_MS,
  maxEntries: 1,
});
const ROSTER_KEY = 'all';
let rosterInFlight: Promise<Podcast[]> | null = null;

async function refreshPlaylistRoster(): Promise<Podcast[]> {
  // A FIXED list of ten, not an attacker-chosen one, so this fans out in
  // parallel rather than probe-first — and each arm already answers [] for a
  // medium PI will not accept, so an unsupported one costs one cheap 400.
  const settled = await Promise.allSettled(
    PLAYLIST_MEDIUMS.map((m) => getFeedsByMedium(m, PLAYLIST_ROSTER_MAX)),
  );

  // **NEVER CACHE A ROSTER NOTHING ANSWERED FOR.** `allSettled`, not `all` with
  // a `.catch(() => [])`, because those two are the same value and opposite
  // claims: a FULFILLED arm is Podcast Index saying "no feeds of this medium"
  // (including the 400 that means it will not accept the medium at all), while a
  // REJECTED one — auth, a 5xx, a dropped connection — is us failing to ask.
  // Flattening the second into the first would write an empty roster on one
  // transient outage and serve it as fact for six hours, which is the lane
  // silently ceasing to exist with nothing on screen or in a log to say so. It
  // is the same rule `readIsTrustworthy` exists for, one subsystem over.
  const answered = settled.filter((r) => r.status === 'fulfilled');
  if (!answered.length) return playlistRoster.get(ROSTER_KEY, Date.now())?.value ?? [];

  const feeds = answered.flatMap((r) => (r as PromiseFulfilledResult<Podcast[]>).value);
  playlistRoster.set(ROSTER_KEY, feeds, Date.now());
  return feeds;
}

/**
 * Playlists matching a typed query, from PI's whole index rather than from
 * `/search/byterm` — which has no medium parameter and therefore cannot be
 * asked for one.
 *
 * **Never blocks a search on a cold roster.** The first search after a restart
 * returns no playlist lane and warms the roster behind itself, so the cost of a
 * cold cache is a lane that is missing once, not a search that waits on ten PI
 * round trips. A stale-but-servable roster is used as-is and refreshed the same
 * way. Both are the accelerator rule the read index follows: this lane may be
 * absent, and its absence must never be reported as "there are no playlists".
 *
 * Returns `[]` for every failure, because a search must not fail over its
 * secondary lane.
 */
export async function searchPlaylistFeeds(query: string, limit: number): Promise<Podcast[]> {
  const hit = playlistRoster.get(ROSTER_KEY, Date.now());
  if (!hit || hit.ageMs >= PLAYLIST_ROSTER_FRESH_MS) {
    // Deduped: several concurrent searches on a cold roster share one refresh.
    if (!rosterInFlight) {
      rosterInFlight = refreshPlaylistRoster()
        .catch(() => [])
        .finally(() => { rosterInFlight = null; });
    }
    // COLD: wait for it, but only briefly.
    //
    // Skipping outright was wrong for the one search that matters most. A
    // playlist is a NEW kind of feed, so somebody typing a playlist's name is
    // very often looking for exactly what this lane exists to find — and on a
    // serverless runtime "cold" is not a once-per-deploy event, it is every new
    // instance. Handing that search a missing lane makes the feature look like
    // it does not work, then work on a retry, which is the hardest failure to
    // report and the easiest to dismiss.
    //
    // Bounded rather than awaited, because the lane must never be able to hold a
    // search hostage: ten small parallel requests to a healthy index land well
    // inside this, and a slow or dead one costs the deadline exactly once,
    // after which the refresh continues in the background and the NEXT search is
    // served from cache. The timer is cleared either way — an unref'd pending
    // timeout is a lambda kept alive for nothing.
    if (!hit) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const feeds = await Promise.race([
        rosterInFlight,
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ROSTER_COLD_WAIT_MS); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      return matchPlaylistsByQuery(feeds ?? [], query, limit);
    }
  }
  return matchPlaylistsByQuery(hit?.value ?? [], query, limit);
}

// ─── The DeMu roster (/demu) ─────────────────────────────────────────────────
//
// Every self-hosted music album, for the /demu page. The playlist roster above
// is the pattern, and each rule below exists for the same reason it does there.
// Design: docs/superpowers/specs/2026-11-15-demu-page-design.md.
//
// ONE call: `/podcasts/bymedium?medium=music` answers all of PI's music feeds
// at once (8,671 on 2026-11-15, ~1 s) and ignores `max`. `demuRosterRows`
// (lib/demu.ts, pinned by `check:demu`) keeps the DeMu ones: no Wavlake
// generator, no closed host, not dead, one row per guid.

/** A music feed changes slowly; one refresh serves six hours. */
const DEMU_ROSTER_FRESH_MS = 6 * 60 * 60_000;
/** A failed refresh keeps serving the last good roster for up to a day. */
const DEMU_ROSTER_STALE_MS = 24 * 60 * 60_000;
/**
 * How long a page load waits on a COLD roster before it answers "not loaded
 * yet"; past this the refresh keeps running and the next load is served from
 * cache. 8 s, not the curated roster's 2.5 s: a refresh is now the music list
 * and the value file in parallel, then the batch calls — ~2–3.5 s measured on
 * 2026-11-16 — and this route serves only the /demu page, which says "loading
 * DeMu…" while it waits. Under the bound, a cold instance's first visitor
 * would mostly get "Could not load". Still inside PI_TIMEOUT_MS-sized calls.
 */
const DEMU_ROSTER_COLD_WAIT_MS = 8000;
/**
 * The whole music list is one body: 9.9 MB on 2026-11-15, over the shared
 * `MAX_BODY_BYTES`, which would THROW rather than truncate. Room to grow.
 */
const DEMU_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Chad's V4V rule needs to know which feeds carry `<podcast:value>`, and the
 * music list does not say. PI's static file of every feed with a value block:
 * one fetch, no key (it refuses a request without a User-Agent), 18.4 MB and
 * ~0.7 s on 2026-11-16. It is DAYS old (Last-Modified 2026-11-11 that day), so
 * it misses the newest feeds — the batch call below covers those.
 */
const DEMU_VALUE_FILE_URL = 'https://tracking.podcastindex.org/feedValueBlocks.json';
const DEMU_VALUE_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** `/podcasts/batch/byguid` answers at most 25 feeds per request (measured: 30, 50 and 100 all stop at 26). */
const DEMU_BATCH_SIZE = 25;

/** Ids of every feed PI's static file lists with a value block. Throws when the file cannot be read. */
async function fetchValueFeedIds(): Promise<Set<number>> {
  const res = await fetch(DEMU_VALUE_FILE_URL, {
    headers: { 'User-Agent': process.env.APP_NAME ?? BRAND.userAgent },
    cache: 'no-store',
    signal: AbortSignal.timeout(PI_TIMEOUT_MS * 2),
  });
  if (!res.ok) throw new Error(`feedValueBlocks.json ${res.status}`);
  const rows: unknown = JSON.parse(await readCappedText(res, DEMU_VALUE_FILE_MAX_BYTES));
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('feedValueBlocks.json read no rows');
  const ids = new Set<number>();
  for (const r of rows) {
    const id = (r as { id?: unknown })?.id;
    if (typeof id === 'number') ids.add(id);
  }
  return ids;
}

/**
 * Whether each guid's feed has a value block, from the LIVE batch call — for
 * the feeds the static file does not list yet. `valueBlock` there is a JSON
 * string or null (`hasValueBlock` reads both shapes). Lower-cased guid keys.
 * Throws on a PI failure, so the whole refresh fails and is not cached.
 */
async function batchHasValue(guids: readonly string[]): Promise<Map<string, boolean>> {
  const chunks: string[][] = [];
  for (let i = 0; i < guids.length; i += DEMU_BATCH_SIZE) chunks.push(guids.slice(i, i + DEMU_BATCH_SIZE));
  const answers = await mapLimit(chunks, PI_FANOUT, async (chunk) => {
    const res = await fetch(BASE + '/podcasts/batch/byguid', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk),
      cache: 'no-store',
      signal: AbortSignal.timeout(PI_TIMEOUT_MS),
    });
    if (!res.ok) throw new PiHttpError(res.status, await readCappedText(res, 4 * 1024).catch(() => ''));
    const data = JSON.parse(await readCappedText(res)) as { feeds?: unknown };
    return Array.isArray(data.feeds) ? data.feeds : [];
  });
  const out = new Map<string, boolean>();
  for (const feeds of answers) {
    for (const f of feeds as { podcastGuid?: unknown; valueBlock?: unknown }[]) {
      if (typeof f?.podcastGuid === 'string') out.set(f.podcastGuid.toLowerCase(), hasValueBlock(f.valueBlock));
    }
  }
  return out;
}

/**
 * At most this many TRACKS (summed `episodeCount`) in one `/episodes/byfeedid`
 * call for the copy rule. PI's `max` is GLOBAL across the ids and caps at
 * `PI_EPISODE_MAX` (1000); 400 leaves room for a count that lags the feed.
 * An album over it is never read, so it is never a copy.
 */
const DEMU_TRACKS_PER_CALL = 400;

/**
 * Each album's audio URLs from Podcast Index, for the copy rule
 * (`demuCopiesToHide`, lib/demu.ts). One `/episodes/byfeedid` call takes many
 * ids and no `since` (measured 2026-11-17: 8084427,8084476,8084510 answer one
 * catbox MP3 each). Two or three calls for the candidates of 2026-11-17.
 *
 * A call that fails, or comes back FULL (`max` reached, so some feed lost
 * tracks), leaves its albums out of the map — and an album that is not in the
 * map is never a copy. So a PI failure here shows a copy, never hides an album,
 * and does not fail the refresh.
 */
async function demuTrackLists(albums: readonly DemuAlbum[]): Promise<Map<number, string[]>> {
  const chunks: DemuAlbum[][] = [];
  let chunk: DemuAlbum[] = [];
  let tracks = 0;
  for (const a of albums) {
    const n = a.episodeCount ?? 0;
    if (n <= 0 || n > DEMU_TRACKS_PER_CALL) continue;
    if (chunk.length && (tracks + n > DEMU_TRACKS_PER_CALL || chunk.length >= PI_FEED_IDS_MAX)) {
      chunks.push(chunk);
      chunk = [];
      tracks = 0;
    }
    chunk.push(a);
    tracks += n;
  }
  if (chunk.length) chunks.push(chunk);
  const out = new Map<number, string[]>();
  await mapLimit(chunks, PI_FANOUT, async (ids) => {
    try {
      const data = await pi<{ items?: unknown }>(`/episodes/byfeedid?id=${ids.map((a) => a.id).join(',')}&max=${PI_EPISODE_MAX}`);
      const rows = Array.isArray(data?.items) ? (data.items as { feedId?: unknown; enclosureUrl?: unknown }[]) : [];
      if (rows.length >= PI_EPISODE_MAX) return;
      const lists = new Map<number, string[]>(ids.map((a) => [a.id, []]));
      for (const r of rows) {
        const list = lists.get(Number(r?.feedId));
        if (list && typeof r?.enclosureUrl === 'string' && r.enclosureUrl.trim()) list.push(r.enclosureUrl.trim());
      }
      for (const [id, list] of lists) out.set(id, list);
    } catch (e) {
      console.warn('[pi] DeMu copy rule could not read tracks; those albums stay:', e instanceof Error ? e.message : e);
    }
  });
  return out;
}

/**
 * The feeds Homegrown Hits plays — shown on /demu with or without a value
 * block, and beyond the hide list's reach (`keepForDemu`). The show's own feed
 * (1.3 MB on 2026-11-16) is read through `remoteItemFeedGuids`. A failure is
 * NOT a failed refresh: the list then follows the other rules alone, which
 * drops only the few played feeds without a value block (1 of 477 that day),
 * and the next refresh restores them.
 */
async function fetchHomegrownHitsPlayed(): Promise<Set<string>> {
  try {
    const res = await fetch(HOMEGROWN_HITS_FEED_URL, {
      headers: { 'User-Agent': process.env.APP_NAME ?? BRAND.userAgent },
      cache: 'no-store',
      signal: AbortSignal.timeout(PI_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return new Set(remoteItemFeedGuids(await readCappedText(res, 16 * 1024 * 1024)));
  } catch (e) {
    console.warn('[pi] Homegrown Hits feed unreadable; /demu follows the other rules alone:', e instanceof Error ? e.message : e);
    return new Set();
  }
}

const DEMU_HIDDEN = new Set(DEMU_HIDE_LIST.map((h) => h.guid.toLowerCase()));
const DEMU_HIDDEN_AUTHORS = new Set(DEMU_HIDE_AUTHORS);

const demuRoster = createBoundedCache<DemuAlbum[]>({
  maxAgeMs: DEMU_ROSTER_STALE_MS,
  maxEntries: 1,
});
const DEMU_KEY = 'music';
let demuInFlight: Promise<DemuAlbum[] | null> | null = null;

/**
 * One refresh. Resolves `null` when Podcast Index could not be asked, and that
 * null is NEVER cached: "nobody answered" written as an empty roster would be
 * served for six hours as "there is no DeMu music" — the page saying so over a
 * PI outage, with nothing in a log to show why.
 */
async function refreshDemuRoster(): Promise<DemuAlbum[] | null> {
  try {
    const [data, valueIds, played] = await Promise.all([
      pi<unknown>('/podcasts/bymedium?medium=music', DEMU_MAX_BYTES),
      fetchValueFeedIds(),
      fetchHomegrownHitsPlayed(),
    ]);
    // `null` when the answer read nothing — never cached, for the reason above.
    const candidates = demuRosterFromPi(data, closedService);
    if (!candidates) {
      console.warn('[pi] DeMu roster refresh read no DeMu albums; not cached');
      return null;
    }
    // Chad's rules, in his order (`keepForDemu`): played by Homegrown Hits →
    // shown; on the hide list → not; made by MSP → shown; otherwise a value
    // block is required — the static file's, plus the live batch answer for
    // feeds the file does not list.
    const rows = (data as { feeds?: unknown } | null)?.feeds;
    const msp = mspFeedGuids(Array.isArray(rows) ? (rows as PiMusicRow[]) : []);
    // Only a HIDDEN feed skips the batch question. A played or MSP feed is shown
    // either way, but its NO VALUE BLOCK stamp must rest on an answer, not on the
    // static file being days old (`valueMissing` in lib/demu.ts).
    const batch = await batchHasValue(demuValueGaps(candidates, valueIds, DEMU_HIDDEN));
    const shown = keepForDemu(candidates, { valueIds, batch, played, hidden: DEMU_HIDDEN, msp, hiddenAuthors: DEMU_HIDDEN_AUTHORS });
    // Then one row per set of tracks: an older COPY of an album on the list goes
    // (`demuCopiesToHide`, Chad, 2026-11-17). After `keepForDemu`, so a copy is
    // compared only with albums that are shown. A failed read hides nothing.
    const copies = demuCopiesToHide(shown, await demuTrackLists(demuCopyCandidates(shown)), played);
    const kept = copies.size ? shown.filter((a) => !copies.has(a.id)) : shown;
    // A NO VALUE BLOCK stamp must be true of the FEED, not of PI's channel-level
    // data: MOOKY pays from an item-level block PI does not see. So each marked
    // album's own RSS decides (a handful of feeds, through safeFetch and the RSS
    // cache); an unreadable one loses the mark rather than gaining a false claim.
    const rss = new Map<string, boolean | null>();
    await mapLimit(kept.filter((a) => a.valueMissing && a.podcastGuid), FEED_FANOUT, async (a) => {
      const xml = a.url ? await fetchFeedXml(a.url) : null;
      rss.set(a.podcastGuid!.toLowerCase(), xml == null ? null : feedHasValueTag(xml));
    });
    const confirmed = confirmValueMissing(kept, rss);
    // An album with no cover at all borrows its newest track's, from its own RSS
    // (`newestItemImage`) — 4 feeds on 2026-11-16, all Crem Road. Same reader and
    // fan-out as above; a feed that cannot be read keeps its letter placeholder.
    const covers = new Map<string, string>();
    await mapLimit(confirmed.filter((a) => !a.image && !a.artwork && a.url && a.podcastGuid), FEED_FANOUT, async (a) => {
      const xml = await fetchFeedXml(a.url!);
      const img = xml == null ? undefined : newestItemImage(xml);
      if (img) covers.set(a.podcastGuid!.toLowerCase(), img);
    });
    const albums = withCoverFallback(confirmed, covers);
    if (!albums.length) {
      console.warn('[pi] DeMu roster refresh kept no album with a value block; not cached');
      return null;
    }
    demuRoster.set(DEMU_KEY, albums, Date.now());
    return albums;
  } catch (e) {
    console.warn('[pi] DeMu roster refresh failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * The DeMu roster for `/api/demu`.
 *
 * `answered: false` means NOT LOADED (cold and not ready inside the bound, or
 * every refresh so far failed), never "empty": the page must say "could not
 * load", and the route must not let a CDN keep that answer. A stale roster is
 * served as-is while a refresh runs behind it; refreshes are deduped.
 */
export async function getDemuRoster(): Promise<{ albums: DemuAlbum[]; answered: boolean; fetchedAt: number | null }> {
  const now = Date.now();
  const hit = demuRoster.get(DEMU_KEY, now);
  if (!hit || hit.ageMs >= DEMU_ROSTER_FRESH_MS) {
    if (!demuInFlight) {
      demuInFlight = refreshDemuRoster().finally(() => { demuInFlight = null; });
    }
    if (!hit) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const albums = await Promise.race([
        demuInFlight,
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), DEMU_ROSTER_COLD_WAIT_MS); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      return albums
        ? { albums, answered: true, fetchedAt: Date.now() }
        : { albums: [], answered: false, fetchedAt: null };
    }
  }
  return { albums: hit.value, answered: true, fetchedAt: now - hit.ageMs };
}

export async function getPodcast(feedId: number): Promise<Podcast | null> {
  try {
    const data = await pi<any>(`/podcasts/byfeedid?id=${feedId}`);
    return podcastFromPiFeed(data.feed);
  } catch (e) {
    // A miss, not an outage — see `isPiMiss`. Every caller already handles null.
    if (isPiMiss(e)) return null;
    throw e;
  }
}

export async function getPodcastByFeedUrl(feedUrl: string): Promise<Podcast | null> {
  try {
    const data = await pi<any>(`/podcasts/byfeedurl?url=${encodeURIComponent(feedUrl)}`);
    return podcastFromPiFeed(data.feed);
  } catch (e) {
    // PI answers an unknown feed URL with **400** `{"status":"false",
    // "description":"Feed url not found."}` — a normal miss, not an outage.
    // Return null so the route 404s. Letting it 500 would trip the client-side
    // PI breaker (`resolveVia` in lib/podcast-meta.ts treats 5xx as "PI is
    // down"), disabling all podcast metadata resolution for the rest of the
    // tab — so one unresolvable podroll feedUrl would take out favorites
    // hydration and the feed's podcast chips. Auth (401/403) and 5xx still
    // throw: those really are breaker-worthy.
    if (isPiMiss(e)) return null;
    throw e;
  }
}

/**
 * A feed on a CLOSED host, followed to its live copy with the same guid.
 *
 * RSS Blue closed (2026-11-14) and its feeds, covers and audio answer 410, but
 * Podcast Index still serves those records as healthy and `/podcasts/byguid`
 * returns the dead copy even when a live one carries the same guid (Worried:
 * dead 7101864, live Fountain 7520866). Only a title search lists both. See
 * `lib/moved-feeds.ts` for why a host list decides "closed", and
 * docs/superpowers/specs/2026-11-14-moved-feeds-design.md.
 *
 * - A record NOT on a closed host comes back untouched with NO request — this
 *   runs on every guid resolve, and a healthy feed must cost nothing.
 * - The twin must have the same guid AND the same artist (`pickLiveTwin`): it is
 *   followed with no press, payee included (Chad's choice, 2026-11-14).
 * - A definite answer (twin, or none) is cached per guid for a day. A failed
 *   search is NOT cached and returns the dead record, which is still PI's
 *   answer — "could not ask" is never "there is no twin".
 *
 * Takes and returns PI's RAW record, so the direct path, the index path and the
 * value-split path all build from whichever record this picked.
 */
const twinCache = createBoundedCache<{ twin: any | null }>({
  maxAgeMs: 24 * 60 * 60 * 1000,
  maxEntries: 2000,
});

export async function preferLiveTwin(raw: any): Promise<any> {
  if (!raw || typeof raw !== 'object' || !closedService(raw.url)) return raw;
  if (!raw.podcastGuid || !raw.title) return raw;
  const now = Date.now();
  const hit = twinCache.get(raw.podcastGuid, now);
  if (hit) return hit.value.twin ?? raw;
  try {
    const data = await pi<any>(`/search/bytitle?q=${encodeURIComponent(raw.title)}&max=50&similar`);
    const twin = pickLiveTwin(raw, Array.isArray(data?.feeds) ? data.feeds : []);
    twinCache.set(raw.podcastGuid, { twin }, now);
    return twin ?? raw;
  } catch {
    return raw;
  }
}

/** PI's raw record for a feed guid, after {@link preferLiveTwin}. Null on a miss. */
export async function liveFeedForGuid(feedGuid: string): Promise<any | null> {
  try {
    const data = await pi<any>(`/podcasts/byguid?guid=${encodeURIComponent(feedGuid)}`);
    const feed = Array.isArray(data?.feed) ? data.feed[0] : data?.feed;
    if (!feed || feed.id == null) return null;
    return await preferLiveTwin(feed);
  } catch (e) {
    if (isPiMiss(e)) return null;
    throw e;
  }
}

/**
 * An item PI answered for on a closed host, re-asked on the live same-guid copy.
 *
 * Decided on the record's own URLs, so a healthy item costs nothing: every
 * RSS Blue enclosure ran through `op3.dev/e,pg=…/media.rssblue.com/…`, which
 * `closedService` reads as a path segment. The item guid is kept by the move
 * (measured on the Worried track). A miss on the copy, or any failure, keeps the
 * original answer — a dead record is still better than no record.
 */
export async function twinEpisode(raw: any, feedGuid: string, itemGuid: string): Promise<any> {
  if (!raw || typeof raw !== 'object') return raw;
  if (!closedService(raw.enclosureUrl) && !closedService(raw.feedImage)) return raw;
  try {
    // The twin answer is cached per guid, so a playlist of RSS Blue tracks does
    // not re-ask `/podcasts/byguid` for every one of them (final review): a
    // cached "none" costs nothing, a cached twin costs only the item lookup.
    const cached = twinCache.get(feedGuid, Date.now());
    let twinId: number;
    if (cached) {
      if (!cached.value.twin || cached.value.twin.id == null) return raw;
      twinId = cached.value.twin.id;
    } else {
      const feed = await liveFeedForGuid(feedGuid);
      if (!feed || feed.id == null || closedService(feed.url)) return raw;
      twinId = feed.id;
    }
    if (twinId === raw.feedId) return raw;
    const data = await pi<any>(
      `/episodes/byguid?guid=${encodeURIComponent(itemGuid)}&feedid=${encodeURIComponent(String(twinId))}`,
    );
    return data?.episode?.guid ? data.episode : raw;
  } catch {
    return raw;
  }
}

/** A PI search that treats a miss (400/404) as no rows; auth, 429 and 5xx throw. */
async function searchRaw(path: string): Promise<any[]> {
  try {
    const data = await pi<any>(path);
    return Array.isArray(data?.feeds) ? data.feeds : [];
  } catch (e) {
    if (isPiMiss(e)) return [];
    throw e;
  }
}

/**
 * Where a favorite on a closed host may have gone under a NEW guid — offered on
 * its row, swapped only on a press (`<MovedOffer>`). See {@link MovedAnswer}.
 *
 * - Not on a closed host → `{ service: null, candidates: [] }`, one PI call.
 * - On one, with a same-guid live copy → no candidates: the resolvers already
 *   follow that copy, so there is nothing to replace.
 * - Otherwise a title search (which also settles the same-guid question, so
 *   `preferLiveTwin`'s search is not repeated) and an author search,
 *   `movedCandidates` (same title AND artist), and each candidate's items — every
 *   call ONE AT A TIME, because Podcast Index answers a burst with 429. The items
 *   lose their value blocks: they become favorites, and a stored copy must never
 *   name a payee.
 * - Null when PI holds no record for the guid.
 */
export async function findMovedCandidates(guid: string): Promise<MovedAnswer | null> {
  let raw: any;
  try {
    const data = await pi<any>(`/podcasts/byguid?guid=${encodeURIComponent(guid)}`);
    raw = Array.isArray(data?.feed) ? data.feed[0] : data?.feed;
  } catch (e) {
    if (isPiMiss(e)) return null;
    throw e;
  }
  if (!raw || raw.id == null) return null;
  const service = closedService(raw.url);
  if (!service) return { service: null, candidates: [] };
  // ONE title search answers both questions — is there a same-guid copy, and
  // which new-guid copies match — and every call after it runs one at a time.
  // Measured 2026-11-14: Podcast Index answers a burst with 429, and this route
  // used to repeat `preferLiveTwin`'s search and run the rest in parallel.
  const known = twinCache.get(raw.podcastGuid, Date.now());
  if (known?.value.twin) return { service, candidates: [] };
  const byTitle = raw.title ? await searchRaw(`/search/bytitle?q=${encodeURIComponent(raw.title)}&max=50&similar`) : [];
  if (!known && raw.podcastGuid) {
    const twin = pickLiveTwin(raw, byTitle);
    twinCache.set(raw.podcastGuid, { twin }, Date.now());
    if (twin) return { service, candidates: [] };
  }
  const byAuthor = raw.author ? await searchRaw(`/search/byterm?q=${encodeURIComponent(raw.author)}&max=60`) : [];
  const found = movedCandidates(raw, [...byTitle, ...byAuthor]);
  const candidates = await mapLimit(found, 1, async (f) => {
    const podcast = podcastFromPiFeed(f);
    let items: Episode[] = [];
    try {
      items = (await getEpisodes(f.id, 200)).map(episodeWithoutValue);
    } catch (e) {
      if (!isPiMiss(e)) throw e;
    }
    return podcast ? { podcast, items } : null;
  });
  return { service, candidates: candidates.filter((c): c is { podcast: Podcast; items: Episode[] } => c !== null) };
}

export async function getPodcastByGuid(guid: string): Promise<Podcast | null> {
  try {
    const data = await pi<any>(`/podcasts/byguid?guid=${encodeURIComponent(guid)}`);
    const feed = Array.isArray(data.feed) ? data.feed[0] : data.feed;
    return podcastFromPiFeed(await preferLiveTwin(feed));
  } catch (e) {
    // A miss, not an outage — see `isPiMiss`. Today PI answers an unknown or
    // malformed guid with 200 and an empty feed, so this arm is defensive:
    // docs/feeds.md's probe-first-then-batch argument already assumes it, and
    // a 400 here would otherwise be a 500 that trips the client breaker.
    if (isPiMiss(e)) return null;
    throw e;
  }
}

/**
 * Podcast Index's record for a feed whose URL lookup missed only because PI
 * stored the URL with whitespace in it (`feedUrlsMatchBarWhitespace`).
 *
 * Found by the `<podcast:guid>` the feed itself declares, and KEPT only when
 * PI's URL for that guid is this URL bar whitespace. The guid alone is not
 * enough: a feed can claim any guid (see `previewPodcastFromChannel`), and the
 * record it took would put another feed's id and favorite heart on this one.
 *
 * For a caller that has just read the feed: the document comes from
 * `fetchFeedXml`'s cache, so the cost is one PI call. Null when the feed
 * declares no guid, PI holds nothing for it, or PI's record is another URL.
 * Throws where `getPodcastByGuid` throws (an outage, not a miss).
 */
export async function getPodcastByDeclaredGuid(feedUrl: string): Promise<Podcast | null> {
  const xml = await fetchFeedXml(feedUrl);
  if (xml == null) return null;
  const guid = extractText(channelSlice(xml), 'podcast:guid')?.trim();
  if (!guid) return null;
  const pi = await getPodcastByGuid(guid);
  return pi && feedUrlsMatchBarWhitespace(pi.url, feedUrl) ? pi : null;
}

// Normalise a raw URI field from <podcast:socialInteract> to a `nostr:` URI.
// Some publishers use https://njump.me/<bech32> instead of the spec-compliant
// `nostr:<bech32>` form — extract the bech32 from either.
function extractNostrUri(raw: string): string | null {
  if (raw.startsWith('nostr:')) return raw;
  const m = raw.match(/\/(n(?:event|ote|addr|profile|pub)1[023456789acdefghjklmnpqrstuvwxyz]+)/);
  return m ? `nostr:${m[1]}` : null;
}

function parseNostrSocialInteracts(raw: any): SocialInteract[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const results: SocialInteract[] = [];
  for (const s of raw) {
    if (typeof s?.uri !== 'string') continue;
    if (s.protocol !== 'nostr') continue;
    const uri = extractNostrUri(s.uri);
    if (!uri) continue;
    results.push({
      uri,
      accountId: typeof s.accountId === 'string' && s.accountId ? s.accountId : undefined,
      priority: typeof s.priority === 'number' ? s.priority : undefined,
    });
  }
  if (!results.length) return undefined;
  return results.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

function parseSocialInteractsFromRss(xml: string): SocialInteract[] | undefined {
  const results: SocialInteract[] = [];
  for (const { attrs } of findTags(xml, 'podcast:socialInteract')) {
    if (readAttr(attrs, 'protocol') !== 'nostr') continue;
    const rawUri = readAttr(attrs, 'uri');
    if (!rawUri) continue;
    const uri = extractNostrUri(rawUri);
    if (!uri) continue;
    const accountId = readAttr(attrs, 'accountId');
    const priorityStr = readAttr(attrs, 'priority');
    results.push({
      uri,
      accountId: accountId || undefined,
      priority: priorityStr !== undefined ? Number(priorityStr) : undefined,
    });
  }
  if (!results.length) return undefined;
  return results.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

function buildEpisode(e: any): Episode {
  return {
    id: e.id,
    guid: e.guid,
    title: e.title,
    description: e.description,
    link: typeof e.link === 'string' && e.link ? e.link : undefined,
    enclosureUrl: e.enclosureUrl,
    enclosureType: e.enclosureType,
    enclosureLength: numOrUndef(e.enclosureLength),
    duration: e.duration,
    datePublished: e.datePublished,
    image: e.image || e.feedImage || undefined,   // see buildPodcast: PI sends "", not absent
    feedId: e.feedId,
    feedTitle: e.feedTitle,
    feedImage: e.feedImage,
    podcastGuid: e.podcastGuid,
    episode: typeof e.episode === 'number' ? e.episode : null,
    season: typeof e.season === 'number' && e.season > 0 ? e.season : null,
    chaptersUrl: typeof e.chaptersUrl === 'string' && e.chaptersUrl.length > 0 ? e.chaptersUrl : undefined,
    ...transcriptFromPi(e),
    socialInteract: parseNostrSocialInteracts(e.socialInteract),
  };
}

/**
 * PI's ceiling for one `/episodes/byfeedid` call, and the number `/api/feed`
 * asks for. There is no offset or "older than" parameter on that endpoint —
 * `max` is the only lever — so an item we don't ask for here is an item no
 * later call can reach, and the reader simply never sees it. A feed longer
 * than this is the one case the app still truncates; see docs/feeds.md.
 */
export const PI_EPISODE_MAX = 1000;

/**
 * What came out on these feeds since `since` — one call, many feeds.
 *
 * `/episodes/byfeedid` takes a comma-separated id list, which is the primitive
 * the "new episodes from your favorites" section is built on: it collapses
 * "did anything change" and "what changed" into one question, so there is no
 * freshness field to keep warm and no seven-day cache to read it through.
 *
 * **`since` is EXCLUSIVE** (measured): an item whose `datePublished` equals it
 * is omitted. So the caller stores the exact `datePublished` of the newest row
 * it showed, with no off-by-one.
 *
 * **`max` is GLOBAL, not per feed**, and applied after a newest-first sort — so
 * hitting it drops the OLDEST rows across every feed at once. The caller has to
 * know when that happened, because the rows it did not see lie between its mark
 * and the ones it did; `truncated` is that signal, and `advanceMarks` refuses
 * to move any mark in a truncated batch.
 *
 * **No `fulltext`.** This list is a set of headlines, not reading material, and
 * `fulltext` scales the body with the ask — the trap `getEpisodes` documents
 * one function down.
 *
 * **A miss is NOT turned into an empty answer here**, unlike every other wrapper
 * in this file, and on purpose. An empty answer would put the ids in the
 * route's `covered`, and the section would then say "nothing new" about shows
 * Podcast Index did not answer for — the one claim that feature must earn. So
 * this throws, and `/api/new-episodes` tells a miss from an outage itself
 * (`isPiMiss` on its probe): a missed chunk stays out of `covered`, an outage
 * becomes a 5xx.
 */
export async function getEpisodesSinceForFeeds(
  feedIds: readonly number[],
  since: number,
  max = 200,
): Promise<{ episodes: Episode[]; truncated: boolean }> {
  const ids = Array.from(new Set(feedIds.filter((n) => Number.isInteger(n) && n > 0)))
    .slice(0, PI_FEED_IDS_MAX);
  if (!ids.length) return { episodes: [], truncated: false };
  const data = await pi<any>(
    `/episodes/byfeedid?id=${ids.join(',')}&since=${Math.floor(since)}&max=${max}`,
  );
  const rows: any[] = Array.isArray(data?.items) ? data.items : [];
  return {
    episodes: rows.map(buildEpisode),
    // `max` is the only lever PI gives here, so a full answer is
    // indistinguishable from a truncated one except by counting.
    truncated: rows.length >= max,
  };
}

/**
 * Ceiling on how many `<item>` blocks one RSS document is walked for.
 *
 * The walk is linear now (`findBlocks`), so this bounds the work AFTER the
 * scan — the sanitizer, the value-block parse and the enrichment map built per
 * item — against a document that is nothing but items. 5000 rather than
 * `PI_EPISODE_MAX`: an oldest-first feed longer than PI's own cap would
 * otherwise lose enrichment for its NEWEST episodes, which are the ones the
 * reader is looking at. Same number as `MAX_PLAYLIST_REFS`, for the same
 * reason — far above any real feed, and a bound rather than a guess.
 */
export const MAX_RSS_ITEMS = 5000;

export async function getEpisodes(feedId: number, max = 25): Promise<Episode[]> {
  const data = await pi<any>(
    `/episodes/byfeedid?id=${feedId}&max=${max}&fulltext`,
    // `fulltext` means PI sends every description untruncated, so the body
    // scales with `max` while the shared cap does not: a 1000-item ask can
    // pass 8 MB, and `readCappedText` answers that with a throw — a show page
    // that worked at 50 items 500ing outright at 1000. 24 KB per episode is
    // well past any real one and keeps the ceiling proportional to the ask.
    max > 100 ? Math.max(MAX_BODY_BYTES, max * 24 * 1024) : undefined,
  );
  return (data.items ?? []).map(buildEpisode);
}

/**
 * Every liveItem record Podcast Index currently holds, across every feed.
 *
 * PI exposes these globally at `/episodes/live` and there is no per-feed
 * endpoint, so this one call is the whole world's live set. `/api/feed` has
 * always paid for it and thrown away every row but one show's (see
 * `getLiveItemsForFeed` below); `/api/live-shows` is the reader that wants the
 * rest of it.
 *
 * **PI sends NO `status`, `startTime` or `endTime` on these rows** (measured
 * 2026-11-13: 40 rows, the plain episode shape, not one of the three fields).
 * An absent status therefore reads as `'live'` — the row is on the live
 * endpoint — and a status PI does send is still obeyed, so an `'ended'` row is
 * dropped if the field ever returns. See `piLiveStatus`. This comment used to
 * say PI sends 'live' | 'pending' | 'ended', and the filter built on that
 * claim emptied the roster. The publisher's own RSS is where status, times and
 * pending items actually live — see `getLiveItemsFromRssDetailed`.
 *
 * NOT routed through `episodeFromPiRecord`. Neither it nor `buildEpisode` maps
 * `liveStatus`/`liveStartTime`, which are the only two fields that make one of
 * these rows a live item rather than an ordinary episode, so they are added
 * here — in the one place that parses this payload.
 *
 * Each call is one upstream request: `pi()` does not use Next's data cache
 * (see the note there). The routes' `Cache-Control` is what collapses repeats.
 */
export async function getGlobalLiveItems(): Promise<Episode[]> {
  return (await getGlobalLiveItemsDetailed()).items;
}

/**
 * {@link getGlobalLiveItems} plus how many rows Podcast Index actually sent.
 *
 * `rawRows` is counted BEFORE either filter below, and it exists because an
 * empty return from this function has two causes that need opposite fixes and
 * are otherwise indistinguishable from any surface: PI sent nothing, or PI sent
 * rows and the `status` test dropped every one of them. Measured in production
 * 2026-09-14, with three podping shows on air, `/api/live-shows` answered
 * `{"items":[],"unverifiedFeeds":0,"truncated":false}` — and nothing in that
 * body, or on the page, said which cause it was.
 *
 * So the count is taken here rather than at the call site. The call site cannot
 * take it: `data.items` is this function's local, and the whole point is to
 * measure the payload as it arrived, not what survived. `/api/live-shows`
 * passes both numbers through to its response.
 *
 * **`statusRows` splits the second cause in two, and that is the whole reason
 * it is a separate number.** There are TWO filters here, not one, and each has
 * already emptied the roster on its own: the `status` test reads a field only
 * Podcast Index's payload shape decides the name and spelling of, and
 * `liveBroadcastIsOver` reads two timestamps PI writes as `0` when it holds
 * none — which is what the `liveStampSecs` call below exists for. Both produce
 * the identical `rawRows > 0, items: []`, and their fixes have nothing in
 * common. `statusRows > 0` with an empty `items` names the clock rule;
 * `statusRows === 0` with `rawRows > 0` names the `status` test.
 *
 * Same split, and same reason, as `getLiveItemsFromRssDetailed` beside
 * `getLiveItemsFromRss`: the detailed one answers a question the bare array
 * cannot express, and every existing caller keeps the simple shape.
 */
export async function getGlobalLiveItemsDetailed(): Promise<{
  items: Episode[];
  rawRows: number;
  statusRows: number;
}> {
  const data = await pi<any>(`/episodes/live?max=1000`);
  const rows: any[] = Array.isArray(data.items) ? data.items : [];
  const out: Episode[] = [];
  let statusRows = 0;
  for (const e of rows) {
    // `piLiveStatus`, never `status === 'live'`: PI sends NO `status` on this
    // endpoint (measured 2026-11-13), and the strict test dropped every row.
    const status = piLiveStatus(e.status);
    if (!status) continue;
    statusRows += 1;
    // `liveStampSecs`, never a bare `typeof === 'number'`: Podcast Index sends
    // `0` for a number it does not hold, and a `0` end read as a time is a
    // broadcast that finished in 1970. That dropped every live row PI sent.
    const startTime = liveStampSecs(e.startTime);
    const endTime = liveStampSecs(e.endTime);
    // The same rule the RSS parser applies, for the case RSS never gets read.
    // A `pi-only` row survives an unreadable feed on purpose, so without this a
    // broadcast whose flag was never flipped would sit on the page unchallenged
    // by anything. PI is not observed to send `end`, so in practice this is the
    // 24 h ceiling — which is exactly the shape of the failure: a show that
    // ended days ago and still says `live`.
    //
    // This is the BACKSTOP, not the ordinary exit. Normally the publisher ends
    // the broadcast, podping carries that here within seconds, and the row
    // simply stops being returned as `live` — which is why an item that runs
    // past its declared `end` is kept rather than cut off. See
    // `liveBroadcastIsOver`.
    if (liveBroadcastIsOver({ status, startTime, endTime }, Math.floor(Date.now() / 1000))) continue;
    out.push({
      ...buildEpisode(e),
      liveStatus: status,
      liveStartTime: startTime,
      liveEndTime: endTime,
    });
  }
  return { items: out, rawRows: rows.length, statusRows };
}

/**
 * The live items for one feed, filtered out of the global roster above.
 *
 * `Number(...)` on both sides is load-bearing: PI does not reliably send
 * `feedId` as a number, `buildEpisode` copies it through unconverted, and a
 * strict `===` against a string matches nothing at all — which would empty the
 * live section of every show page while looking like PI had simply gone quiet.
 */
export async function getLiveItemsForFeed(feedId: number): Promise<Episode[]> {
  const all = await getGlobalLiveItems();
  return all.filter((e) => Number(e.feedId) === Number(feedId));
}

// In-memory cache of raw feed XML, keyed by URL. A single feed-page load
// parses the same feed twice — once for episode enrichment (socialInteract /
// show notes / track order) and once for live items — and the /api/feed route
// awaits them in sequence, so without this the same URL is fetched (and
// re-downloaded) back-to-back. The first parse populates the cache; the second
// is an instant hit. The window also collapses repeat requests for the same
// feed across page loads.
//
// Two-tier freshness:
//   - within FRESH window: serve cached XML without refetching. This cache is
//     the only server-side copy: `safeFetch` never uses Next's data cache.
//   - past FRESH but within STALE: refetch; if the refetch FAILS, serve the
//     last-known-good copy rather than blanking the feed's live items /
//     enrichment on a transient publisher outage (stale-while-error).
// A successful fetch always replaces the cached copy and resets both windows.
//
// BOUNDED, and it has to be. The key is a feed URL that reaches here from
// untrusted data, and the value is a whole RSS body. Entries past STALE stopped
// being *read* but were never *deleted*, so the map only ever grew: iterating
// distinct `?url=` values pinned one full feed body each, for the life of the
// instance, with no ceiling on the count. Insertion order is eviction order —
// a `Map` iterates oldest-first, so the first key is the least recently
// inserted. That is by insert time, not access time; a true LRU would need a
// re-set on every hit, and for a cache whose entries expire on a timer anyway
// the extra bookkeeping buys nothing.
const RSS_FRESH_MS = 60_000;
const RSS_STALE_MS = 10 * 60_000;
const RSS_CACHE_MAX = 200;
// **The entry cap is not the memory bound.** Bodies are read at
// `MAX_BODY_BYTES` (8 MB), so 200 entries is 1.6 GB of ceiling — and
// `/api/publisher` walks up to 100 children of a feed-supplied publisher
// document in ONE request, each landing here. Measured for scale: all ten of
// ChadF's playlist source feeds together are 9.5 MB and the largest is 2.5 MB,
// so 64 MB is several times the real working set and still bounds the worst
// case to something a function can hold.
const RSS_CACHE_MAX_BYTES = 64 * 1024 * 1024;
// The sweep/delete-then-set/cap bookkeeping is `createBoundedCache`, shared with
// lib/musicl-resolver.ts — both caches shipped the same unbounded-growth bug
// because the mechanism had been copied. Only the POLICY is local: the horizon
// here is the stale window (not the fresh one), because a body past 60 s is
// still servable on a failed refetch and must not be swept until 10 min.
const rssXmlCache = createBoundedCache<string>({
  maxAgeMs: RSS_STALE_MS,
  maxEntries: RSS_CACHE_MAX,
  maxBytes: RSS_CACHE_MAX_BYTES,
  sizeOf: (xml) => xml.length,
});

/**
 * How stale a feed's XML may be when a LIVE route answers from it:
 * `/api/live-status`, `/api/live-value` and `/api/live-shows` all pass this as
 * `maxAgeMs`. A live item's status and its now-playing turn over inside a
 * minute, so the shared 60 s window is too coarse for them — but the override
 * applies to THOSE calls only, so `/api/feed` and every other reader keep the
 * cheaper shared window. One number, because the three routes mirror each
 * other on purpose: a live show must not read as live on one and ended on
 * another for the same poll.
 */
export const LIVE_XML_MAX_AGE_MS = 10_000;

// `maxAgeMs` shortens the fresh window for ONE caller without shortening it for
// everyone. The live-value poller needs the current "now playing", which turns
// over every few minutes; the normal feed path does not, and dropping the
// shared 60 s window to match would re-fetch every publisher's RSS on every
// page load. A successful short-TTL fetch still populates the shared cache, so
// the two paths cooperate rather than duplicating work.
async function fetchFeedXml(
  rssUrl: string,
  opts?: { maxAgeMs?: number },
): Promise<string | null> {
  const now = Date.now();
  const freshMs = opts?.maxAgeMs ?? RSS_FRESH_MS;
  // `hit` is anything inside the 10 min horizon; `freshMs` is this caller's own
  // (possibly shorter) idea of fresh. The cache deliberately doesn't judge.
  const hit = rssXmlCache.get(rssUrl, now);
  if (hit && hit.ageMs < freshMs) return hit.value;

  let xml: string | null = null;
  try {
    const res = await safeFetch(rssUrl, {
      headers: { 'User-Agent': process.env.APP_NAME ?? BRAND.userAgent },
      signal: AbortSignal.timeout(8000),
    });
    // Capped: `rssUrl` is feed-supplied and the result is RETAINED below, so an
    // unbounded read is not one big allocation, it's one big allocation that
    // stays.
    if (res.ok) xml = await readCappedText(res);
  } catch {
    // fall through to the stale-on-error path
  }

  if (xml != null) {
    rssXmlCache.set(rssUrl, xml, now);
    return xml;
  }
  // Fetch failed or returned non-2xx — serve the last good copy. `hit` is
  // already bounded by the stale window (the cache's own horizon), so reaching
  // here with one in hand means it is still servable.
  if (hit) return hit.value;
  return null;
}

/**
 * How much of a feed a LIVE read will download, in all, to prove it carries no
 * live item past the 8 MB it keeps. Nothing past `MAX_BODY_BYTES` is kept, so
 * this bounds bytes on the wire and time, never the heap.
 *
 * Measured 2026-11-25: Global Voice Radio Network's Podhome feed was 11.9 MB
 * with 2,400 episodes, and it grows with every episode. Past this ceiling the
 * read is unreadable again, as every feed over 8 MB was before.
 */
const LIVE_SCAN_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The live-item-only documents of feeds too large to keep whole — see
 * `liveReadDocument`. A SEPARATE cache from `rssXmlCache` on purpose: that one
 * is read by `/api/feed` and every other parser as the whole feed, and a
 * document of live items alone would read there as a feed with no episodes.
 * Same windows as that cache: fresh per caller, servable for 10 minutes when
 * the publisher is down. Each entry is a few kilobytes of live items.
 */
const liveXmlCache = createBoundedCache<string>({
  maxAgeMs: RSS_STALE_MS,
  maxEntries: RSS_CACHE_MAX,
  maxBytes: 8 * 1024 * 1024,
  sizeOf: (xml) => xml.length,
});

/**
 * Read a feed for its live items: the whole body when it fits in
 * `MAX_BODY_BYTES` (as every read does), otherwise only its live items, and
 * only when the rest of the body proves there are no others (`liveReadDocument`).
 * `null` is "nothing can be proved", never "no live items". Throws like the
 * capped readers (past `LIVE_SCAN_MAX_BYTES`, or the request's own timeout).
 *
 * Fills the matching cache, so the next live read inside the window is a hit.
 * Shared by the request path (`fetchLiveFeedXml`) and the 15-minute check
 * (`checkLiveFeed`), so the cron and the three live routes agree on a large feed.
 */
async function readLiveFeedBody(res: Response, rssUrl: string, now: number): Promise<string | null> {
  const read = await readPrefixThenScan(res, MAX_BODY_BYTES, LIVE_SCAN_MAX_BYTES, LIVE_ITEM_TAG);
  const doc = liveReadDocument(new TextDecoder().decode(read.bytes), read);
  if (!doc) return null;
  if (doc.whole) rssXmlCache.set(rssUrl, doc.xml, now);
  else liveXmlCache.set(rssUrl, doc.xml, now);
  return doc.xml;
}

/**
 * `fetchFeedXml` for a LIVE read: the same windows and the same stale-on-error,
 * but a feed past `MAX_BODY_BYTES` still answers with its live items
 * (`readLiveFeedBody`). A whole feed from `rssXmlCache` serves as before, so a
 * feed `/api/feed` read a moment ago costs nothing here.
 */
async function fetchLiveFeedXml(
  rssUrl: string,
  opts?: { maxAgeMs?: number },
): Promise<string | null> {
  const now = Date.now();
  const freshMs = opts?.maxAgeMs ?? RSS_FRESH_MS;
  const whole = rssXmlCache.get(rssUrl, now);
  if (whole && whole.ageMs < freshMs) return whole.value;
  const liveOnly = liveXmlCache.get(rssUrl, now);
  if (liveOnly && liveOnly.ageMs < freshMs) return liveOnly.value;

  try {
    const res = await safeFetch(rssUrl, {
      headers: { 'User-Agent': process.env.APP_NAME ?? BRAND.userAgent },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const xml = await readLiveFeedBody(res, rssUrl, now);
      if (xml != null) return xml;
    } else {
      await res.body?.cancel().catch(() => {});
    }
  } catch {
    // fall through to the stale-on-error path
  }
  // The newer of the two copies, each already inside its 10-minute horizon.
  const stale = [whole, liveOnly]
    .filter((h): h is NonNullable<typeof h> => h != null)
    .sort((a, b) => a.ageMs - b.ageMs)[0];
  return stale ? stale.value : null;
}

// PI's /episodes/live only indexes currently-broadcasting items; pending
// liveItems live exclusively in the publisher's RSS. Fetch the feed XML
// and pull <podcast:liveItem status="pending|live"> directly.
//
// Hand-rolled regex parser instead of pulling in fast-xml-parser etc — the
// shape we care about (top-level <podcast:liveItem> blocks plus a few
// well-known children) is narrow and stable.
//
// `ok` separates "this feed has no live items" from "we could not read the
// feed", which the bare [] cannot. /api/live-status needs the distinction:
// a client told every item ended would strip a LIVE badge mid-broadcast, and
// on a `pending` item it would enable the play button for a stream that has
// not started. Callers that only want the items keep using
// getLiveItemsFromRss below.
export async function getLiveItemsFromRssDetailed(
  rssUrl: string,
  feedId: number,
  podcastGuid?: string,
  opts?: { maxAgeMs?: number },
): Promise<{ ok: boolean; items: Episode[] }> {
  // `fetchLiveFeedXml`, not `fetchFeedXml`: a feed past 8 MB is still read for
  // its live items, so Podcast Index's word is not the only one on `/live`.
  const xml = await fetchLiveFeedXml(rssUrl, opts);
  if (xml == null) return { ok: false, items: [] };
  const items = parseRssLiveItems(xml).map((r): Episode => ({
    id: -fnvHash(r.guid ?? r.title ?? `${rssUrl}#${r.startTime ?? ''}`),
    guid: r.guid,
    title: r.title ?? 'Untitled live item',
    description: r.description,
    enclosureUrl: r.enclosureUrl ?? '',
    enclosureType: r.enclosureType,
    image: r.image,
    feedId,
    podcastGuid,
    liveStatus: r.status,
    liveStartTime: r.startTime,
    liveEndTime: r.endTime,
    value: r.value,
    socialInteract: r.socialInteract,
    liveValue: r.liveValue,
    // A video rendition of the broadcast (Owncast HLS beside an Icecast MP3).
    // Without it <VideoToggle> never offers 📺 Video on a live item.
    alternateEnclosures: r.alternateEnclosures,
    liveRemoteItem: r.remoteItem,
    liveValueTimeSplits: r.valueTimeSplits?.length ? r.valueTimeSplits : undefined,
  }));
  return { ok: true, items };
}

export async function getLiveItemsFromRss(
  rssUrl: string,
  feedId: number,
  podcastGuid?: string,
  opts?: { maxAgeMs?: number },
): Promise<Episode[]> {
  const { items } = await getLiveItemsFromRssDetailed(rssUrl, feedId, podcastGuid, opts);
  return items;
}

/**
 * One CONDITIONAL read of a feed for the known-live-feeds check (lib/live-feeds.ts),
 * which runs every 15 minutes over every feed on the list.
 *
 * It sends the validators the last read recorded (`If-None-Match`,
 * `If-Modified-Since`), so a feed that has not changed answers `304` and costs
 * no body — `not-modified`, and the caller keeps what it recorded. A `200` is
 * read like every LIVE read (`readLiveFeedBody`: capped, and a feed past 8 MB
 * still answers with its live items), and answers which live items the feed
 * carries now plus whether it carries a `<podcast:liveItem>` of ANY status
 * (`anyLiveItem`: an `ended` item still makes a show a live show).
 *
 * `failed` is every other outcome, and it is not "no live items": the caller
 * must keep what it had. The validators come from a feed host, so they are
 * capped in length, and a value `fetch` refuses as a header is a failed read,
 * never a throw. A successful body also refreshes the shared XML cache, so the
 * request path that reads the same feed a moment later is a hit.
 */
export async function checkLiveFeed(
  rssUrl: string,
  validators: { etag?: string | null; lastModified?: string | null },
): Promise<
  | { kind: 'not-modified' }
  | { kind: 'failed' }
  | {
      kind: 'read';
      etag?: string;
      lastModified?: string;
      anyLiveItem: boolean;
      items: { status: 'pending' | 'live'; startTime?: number; endTime?: number }[];
    }
> {
  const headers: Record<string, string> = { 'User-Agent': process.env.APP_NAME ?? BRAND.userAgent };
  const short = (v: string | null | undefined) => (v && v.length <= 256 ? v : undefined);
  const etag = short(validators.etag);
  const lastModified = short(validators.lastModified);
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;
  try {
    const res = await safeFetch(rssUrl, { headers, signal: AbortSignal.timeout(8000) });
    if (res.status === 304) {
      await res.body?.cancel().catch(() => {});
      return { kind: 'not-modified' };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { kind: 'failed' };
    }
    // The same read the request path makes, so a feed past 8 MB is not
    // `failed` here while `/live` can read it (and the other way round).
    const xml = await readLiveFeedBody(res, rssUrl, Date.now());
    if (xml == null) return { kind: 'failed' };
    const anyLiveItem = findBlocks(xml, LIVE_ITEM_TAG, { max: 1 }).length > 0;
    return {
      kind: 'read',
      etag: short(res.headers.get('etag')),
      lastModified: short(res.headers.get('last-modified')),
      anyLiveItem,
      items: parseRssLiveItems(xml).map((r) => ({ status: r.status, startTime: r.startTime, endTime: r.endTime })),
    };
  } catch {
    return { kind: 'failed' };
  }
}

interface RawLiveItem {
  status: 'pending' | 'live';
  startTime?: number;
  /** The `end` attribute, unix seconds — the publisher's own declaration of
   *  when this broadcast finishes. See `liveBroadcastIsOver`. */
  endTime?: number;
  title?: string;
  description?: string;
  guid?: string;
  enclosureUrl?: string;
  enclosureType?: string;
  image?: string;
  value?: ValueBlock | null;
  socialInteract?: SocialInteract[];
  remoteItem?: ValueTimeSplitRemoteItem;
  valueTimeSplits?: ValueTimeSplit[];
  liveValue?: { uri: string; protocol: string };
  alternateEnclosures?: AlternateEnclosure[];
}

/**
 * `<podcast:liveValue uri="…" protocol="socket.io"/>`
 *
 * The push channel a live show broadcasts its current payment target on — what
 * The Split Kit emits ("copy the tag below and paste into the
 * <podcast:liveItem> of your podcast feed"), and what Sovereign Feeds calls the
 * Live Value Link. This is the signal the live V4V music shows actually use;
 * rewriting the feed per track is the fallback for shows that don't.
 *
 * The uri goes through `httpUrl` because it arrives from a third-party feed and
 * ends up as a socket connection opened from the browser — same fail-closed
 * allowlist direction as safeUrlAttr, for the same reason.
 */
function parseLiveValue(xml: string): { uri: string; protocol: string } | undefined {
  const tag = firstTag(xml, 'podcast:liveValue');
  if (!tag) return undefined;
  const uri = httpUrl(readAttr(tag.attrs, 'uri'));
  if (!uri) return undefined;
  return { uri, protocol: (readAttr(tag.attrs, 'protocol') || '').toLowerCase() };
}

function parseRssLiveItems(xml: string): RawLiveItem[] {
  const out: RawLiveItem[] = [];
  for (const hit of findBlocks(xml, 'podcast:liveItem')) {
    // A self-closing live item has no enclosure and no title: not a broadcast.
    if (hit.selfClosing) continue;
    const attrs = hit.attrs;
    const inner = hit.inner;
    const rawStatus = readAttr(attrs, 'status')?.toLowerCase();
    if (rawStatus !== 'pending' && rawStatus !== 'live') continue;
    // Both stamps go through `liveStampSecs`, the same rule PI's roster gets:
    // an unparseable attribute is `NaN` and a literal epoch date is `0`, and
    // neither is a time a broadcast can be judged against.
    const startStr = readAttr(attrs, 'start');
    const startMs = startStr ? Date.parse(startStr) : NaN;
    const startTime = liveStampSecs(Math.floor(startMs / 1000));
    const endStr = readAttr(attrs, 'end');
    const endMs = endStr ? Date.parse(endStr) : NaN;
    const endTime = liveStampSecs(Math.floor(endMs / 1000));
    // `status="live"` is a flag a human flips, and humans forget — so a stale
    // flag must not render a pulsing badge and a working PLAY button over
    // silence. But `end` is a SCHEDULE and hosts run long, so an on-air show
    // keeps its row for `LIVE_OVERRUN_GRACE_SECS` past that time and leaves on
    // the publisher's own signal instead. Both halves are in
    // `liveBroadcastIsOver`; a broadcast this drops is dropped rather than
    // demoted to 'ended' because `ended` is already dropped two lines above —
    // one shape for "this is over", not two.
    if (liveBroadcastIsOver({ status: rawStatus, startTime, endTime }, Math.floor(Date.now() / 1000))) continue;
    const enc = firstTag(inner, 'enclosure');
    const itunesImg = firstTag(inner, 'itunes:image');
    out.push({
      status: rawStatus,
      startTime,
      endTime,
      title: extractText(inner, 'title'),
      description: extractText(inner, 'description'),
      guid: extractText(inner, 'guid'),
      enclosureUrl: enc ? readAttr(enc.attrs, 'url') : undefined,
      enclosureType: enc ? readAttr(enc.attrs, 'type') : undefined,
      image: itunesImg ? readAttr(itunesImg.attrs, 'href') : undefined,
      value: parseValueBlock(inner),
      socialInteract: parseSocialInteractsFromRss(inner),
      // The "now playing" signals. A remoteItem placed directly in the live
      // item (i.e. not one nested inside a valueTimeSplit) is the explicit
      // pointer; splits are the fallback. Both are read here so the resolver
      // can apply precedence in one place.
      remoteItem: firstRemoteItem(stripValueTimeSplits(inner)),
      valueTimeSplits: parseValueTimeSplitsFromRss(inner),
      liveValue: parseLiveValue(inner),
      // Read the same way as an <item>'s: a live item may carry a video
      // rendition too (Homegrown Hits: an Owncast HLS beside the Icecast MP3).
      alternateEnclosures: parseAlternateEnclosures(inner),
    });
  }
  return out;
}

function parseValueBlock(xml: string): ValueBlock | null {
  const vBlock = firstBlock(xml, 'podcast:value');
  // A self-closing <podcast:value/> names no recipient, so it is no block.
  if (!vBlock || vBlock.selfClosing) return null;
  const vAttrs = vBlock.attrs;
  // <podcast:valueTimeSplit> is a CHILD of <podcast:value>, and it may carry
  // its own inline <podcast:valueRecipient> tags. Strip those blocks before
  // scanning, or a split's recipients get merged into the block's own — the
  // show would pay a guest's segment splits for the whole episode.
  const vInner = stripValueTimeSplits(vBlock.inner);
  const recipients: ValueRecipient[] = [];
  for (const { attrs: ra } of findTags(vInner, 'podcast:valueRecipient')) {
    const address = readAttr(ra, 'address');
    if (!address) continue;
    recipients.push({
      // Display only — decoded so `&amp;` shows as `&`. Never the address.
      name: nameAttr(readAttr(ra, 'name')),
      type: readAttr(ra, 'type') ?? 'node',
      address,
      customKey: readAttr(ra, 'customKey'),
      customValue: readAttr(ra, 'customValue'),
      split: Number(readAttr(ra, 'split') ?? 0) || 0,
      fee: readAttr(ra, 'fee')?.toLowerCase() === 'true',
    });
  }
  if (!recipients.length) return null;
  return {
    type: readAttr(vAttrs, 'type') ?? 'lightning',
    method: readAttr(vAttrs, 'method') ?? 'keysend',
    suggested: readAttr(vAttrs, 'suggested'),
    recipients,
  };
}

const VALUE_TIME_SPLIT_TAG = 'podcast:valueTimeSplit';

function stripValueTimeSplits(xml: string): string {
  return stripBlocks(xml, [VALUE_TIME_SPLIT_TAG]);
}

/** A <podcast:remoteItem> tag's attributes, or null when it names no feed. */
function parseRemoteItem(tagAttrs: string): ValueTimeSplitRemoteItem | null {
  const feedGuid = readAttr(tagAttrs, 'feedGuid');
  if (!feedGuid) return null;
  return {
    feedGuid,
    itemGuid: readAttr(tagAttrs, 'itemGuid'),
    medium: readAttr(tagAttrs, 'medium') || undefined,
  };
}

/** The first <podcast:remoteItem> in a block, if any. */
function firstRemoteItem(xml: string): ValueTimeSplitRemoteItem | undefined {
  const tag = firstTag(xml, 'podcast:remoteItem');
  return (tag && parseRemoteItem(tag.attrs)) || undefined;
}

/**
 * The windows an ordinary item's boost and streaming engine can pay: the ones that
 * name a remote item. **A window with inline recipients stays the show's.** Nothing
 * else keys it: `trackBucket` names a track by its remote item, so inline windows
 * collapse into one bucket, and the last window's people would be paid for all of
 * them. A live item keeps them, because the live path builds its own target.
 */
function itemValueTimeSplits(xml: string): ValueTimeSplit[] {
  return parseValueTimeSplitsFromRss(xml).filter((s) => s.remoteItem?.feedGuid);
}

/**
 * Parse <podcast:valueTimeSplit> children out of raw RSS.
 *
 * Podcast Index's own flat `timesplits` JSON is not read, so this is the only path:
 * tag, which is also what a live item needs, because PI never indexes its children.
 */
function parseValueTimeSplitsFromRss(xml: string): ValueTimeSplit[] {
  const out: ValueTimeSplit[] = [];
  for (const hit of findBlocks(xml, VALUE_TIME_SPLIT_TAG)) {
    const attrs = hit.attrs;
    const inner = hit.inner;
    const remotePctStr = readAttr(attrs, 'remotePercentage');
    const remoteStartStr = readAttr(attrs, 'remoteStartTime');
    // Inline <podcast:valueRecipient> children are an alternative to a
    // remoteItem: wrap them so parseValueBlock can read them unchanged.
    const inlineValue = inner.includes('<podcast:valueRecipient')
      ? parseValueBlock(`<podcast:value>${inner}</podcast:value>`)
      : null;
    out.push({
      startTime: Number(readAttr(attrs, 'startTime')) || 0,
      duration: Number(readAttr(attrs, 'duration')) || 0,
      remoteStartTime: remoteStartStr != null ? Number(remoteStartStr) : undefined,
      remotePercentage: remotePctStr != null ? Number(remotePctStr) : undefined,
      remoteItem: firstRemoteItem(inner),
      value: inlineValue,
    });
  }
  return out;
}

// `extractText` lives in lib/feed-xml.ts, so `check:feedxml` can pin it.

// Extract the raw HTML content of a namespaced RSS tag like content:encoded,
// without entity-decoding or tag-stripping. Handles CDATA wrapping.
function extractRawContent(xml: string, tag: string): string | undefined {
  const hit = firstBlock(xml, tag);
  if (!hit || hit.selfClosing) return undefined;
  const inner = hit.inner.trim();
  const cdata = inner.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
  return ((cdata ? cdata[1] : inner).trim()) || undefined;
}

// Allowed tags in sanitized show notes. Everything else is stripped (content kept).
const SHOW_NOTES_ALLOWED = new Set([
  'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
  'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'span', 'div', 'a', 'img',
]);

// Allowlist-based HTML sanitizer for RSS <content:encoded> show notes.
// Safe for dangerouslySetInnerHTML: allowlists tags, drops every attribute
// except href/src/alt, and forces links to open in a new tab.
//
// URLs are the sharp edge and are handled by safeUrlAttr (lib/safe-url-attr.ts),
// which ALLOWLISTS schemes against the browser-resolved value. This used to say
// it "blocks javascript: and data: URIs" — it did that with a denylist over the
// raw attribute text, and six entity/control-character vectors walked through
// it. Read the header of safe-url-attr.ts before touching that path.

// Some feeds entity-escape their WHOLE notes: structural tags arrive as
// &lt;p&gt; / &lt;a href&gt; and render as literal "<p>" text. Detect that
// (escaped structural tags, not just inline emphasis) so we can decode it.
function looksEscapedHtml(s: string): boolean {
  return /&lt;\/?(p|div|ul|ol|li|blockquote|h[1-6])\b/i.test(s) || /&lt;a\s+href=/i.test(s);
}

// Decode the markup entities (not display entities like &mdash; — the browser
// handles those). &amp; is decoded LAST so it can't re-form the others.
function nameAttr(raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : decodeXmlEntities(raw);
}

function decodeMarkupEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Ceiling on the show notes handed to the sanitizer, in characters.
 *
 * Everything below is linear in the input now, but linear in 8 MB is still 8 MB
 * of regex passes per item, and a document can be nothing but items. Podcast
 * Index itself truncates a description at ~3,000 characters, and the longest
 * real `<content:encoded>` observed is a few tens of KB, so nothing genuine is
 * lost at half a megabyte. Cut BEFORE any pass runs — measuring after is the
 * mistake `readCappedText` exists to prevent, pointed at CPU instead of memory.
 */
const MAX_SHOW_NOTES_CHARS = 512 * 1024;

/**
 * Elements whose CONTENT must go, not just the tag. The allowlist pass below
 * keeps text and drops unknown tags, which is right for `<font>` and wrong for
 * `<script>`: the body of a script is not prose.
 */
const DANGEROUS_BLOCK_TAGS = [
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'select', 'button', 'noscript',
] as const;

function sanitizeShowNotes(html: string): string {
  let out = html.length > MAX_SHOW_NOTES_CHARS ? html.slice(0, MAX_SHOW_NOTES_CHARS) : html;
  // Whole-notes-escaped feeds (e.g. Bowl After Bowl): decode the markup first so
  // <p>/<a>/lists render instead of showing as literal tag text. The allowlist
  // pass below still runs, so decoding can't smuggle anything unsafe.
  if (looksEscapedHtml(out)) out = decodeMarkupEntities(out);
  // Feeds that escape only inline emphasis (real <p>/<a> but &lt;b&gt;/&lt;i&gt;,
  // e.g. Podcasting 2.0's own): un-escape a small whitelist so bold/italic render.
  out = out.replace(/&lt;(\/?)(b|strong|i|em|u|s|br)\s*\/?&gt;/gi, '<$1$2>');
  // The three passes that used to be `[\s\S]*?` regexes, and were quadratic on
  // a document of repeated opens with no close (800 KB of `<!--` measured
  // 38.7 s). Linear scanners now, and `'consume'` because an unclosed
  // <script> swallows the rest of the document in a browser too — see the
  // scanner header in lib/feed-xml.ts.
  out = stripComments(out);
  out = stripBlocks(out, DANGEROUS_BLOCK_TAGS, { unclosed: 'consume' });
  // The two `[^>]*` regexes that follow are linear ONLY once every `<` has a
  // `>` somewhere after it. This makes that true (see escapeDanglingLt).
  out = escapeDanglingLt(out);
  out = out.replace(
    /<(script|style|iframe|object|embed|form|input|textarea|select|button|noscript)\b[^>]*\/?>/gi,
    '',
  );

  out = out.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9:.-]*)([^>]*)>/g, (_, slash, rawTag, attrs) => {
    const tag = rawTag.toLowerCase();
    if (!SHOW_NOTES_ALLOWED.has(tag)) return '';
    if (slash) return `</${tag}>`;
    if (tag === 'br' || tag === 'hr') return `<${tag}>`;
    if (tag === 'a') {
      // Scheme ALLOWLIST against the browser-resolved value — see
      // lib/safe-url-attr.ts. The previous denylist tested the raw attribute
      // and re-emitted it verbatim, so `java&#115;cript:` and `java<TAB>script:`
      // both reached the DOM as javascript:. An anchor with no usable href is
      // kept (as a bare <a>) so the link text still renders.
      const href = safeUrlAttr(readAttr(attrs, 'href'), 'link');
      if (!href) return '<a>';
      return `<a href="${escapeHtmlAttr(href)}" target="_blank" rel="noopener noreferrer">`;
    }
    if (tag === 'img') {
      const src = safeUrlAttr(readAttr(attrs, 'src'), 'image');
      if (!src) return '';
      const alt = readAttr(attrs, 'alt') ?? '';
      return `<img src="${escapeHtmlAttr(src)}" alt="${escapeHtmlAttr(alt)}" loading="lazy">`;
    }
    return `<${tag}>`;
  });

  // Bare URLs FIRST, then nostr refs: a plain-text `https://njump.me/npub1…`
  // becomes one anchor and the nostr pass then skips it, where the other order
  // would wrap the npub in the MIDDLE of a text URL and mangle both.
  out = linkifyBareUrls(out);
  out = linkifyNostrRefs(out);
  return out.trim();
}

/**
 * Apply `fn` to the TEXT of already-sanitized notes HTML — never inside a tag,
 * and never inside an existing `<a>…</a>` block.
 *
 * Both linkify passes below go through this. Skipping anchor blocks stops a
 * feed's own link from being double-wrapped; skipping tags stops a match inside
 * an attribute (an npub or a URL sitting in an `<img src>`) from splicing an
 * `<a>` into the middle of the tag, which would corrupt the markup.
 */
function mapNotesText(html: string, fn: (text: string) => string): string {
  // `escapeDanglingLt` again, not only in sanitizeShowNotes: the allowlist tag
  // pass between the two can delete the document's last `>`, which re-exposes
  // a `<` tail and with it the quadratic shape in the tag split below.
  return splitAnchors(escapeDanglingLt(html))
    .map((block, i) =>
      i % 2 === 1
        ? block // an existing anchor block — leave verbatim
        : block
            .split(/(<[^>]*>)/g)
            .map((seg, j) => (j % 2 === 1 ? seg : fn(seg)))
            .join(''),
    )
    .join('');
}

// Turn bare http(s) URLs the feed wrote as plain text into real links — the
// common shape for a "Links:" block at the foot of the notes, which otherwise
// renders as unclickable text a phone user can only select and paste.
//
// This is the case CLAUDE.md's warning covers: a post-allowlist pass emitting a
// FEED-DERIVED URL has no sanitizer behind it, so the href goes through
// safeUrlAttr/escapeHtmlAttr exactly as the tag pass does. The regex already
// anchors on http(s), so that is belt-and-braces rather than the only check.
// The LABEL is the matched text verbatim: it came out of the HTML stream, so it
// is already correctly encoded for a text context, and it cannot contain `<`.
function linkifyBareUrls(html: string): string {
  return mapNotesText(html, (text) =>
    splitOnBareUrls(text)
      .map((seg, i) => {
        if (i % 2 === 0) return seg;
        const href = safeUrlAttr(seg, 'link');
        return href
          ? `<a href="${escapeHtmlAttr(href)}" target="_blank" rel="noopener noreferrer">${seg}</a>`
          : seg;
      })
      .join(''),
  );
}

// Turn bare nostr identifiers in the (already-sanitized) notes HTML into
// njump.me links — npubs/nprofiles/etc. that feeds list as plain text. Runs
// after the allowlist pass so every real <a> is normalized. bech32 is [0-9a-z]
// only, so the href/label need no escaping. njump.me is the app's universal
// nostr link convention (see nostr-note-card.tsx / live-chat.tsx).
const NOSTR_REF_RE =
  /(?<![\w])((?:nostr:)?n(?:pub|profile|event|ote|addr)1[023456789acdefghjklmnpqrstuvwxyz]{20,})/gi;

function linkifyNostrRefs(html: string): string {
  return mapNotesText(html, (text) =>
    text.replace(NOSTR_REF_RE, (m) => {
      const bech = m.replace(/^nostr:/i, '');
      // Mark person refs (npub/nprofile) so the client can attach a follow
      // button; events (nevent/note/naddr) aren't people, so no marker.
      const person = /^n(pub|profile)1/i.test(bech) ? ` data-npub="${bech}"` : '';
      return `<a href="https://njump.me/${bech}" target="_blank" rel="noopener noreferrer"${person}>${m}</a>`;
    }),
  );
}

interface RssEpisodeEnrichment {
  /** The item's own `<enclosure url>`, byte for byte. Read from the live feed
   *  because Podcast Index can hold a stale one — see `feedEnclosure`
   *  (lib/util.ts). */
  enclosureUrl?: string;
  enclosureType?: string;
  enclosureLength?: number;
  nostrNpubs?: FeedNpub[];
  socialInteract?: SocialInteract[];
  contentEncoded?: string;
  season?: number | null;
  episode?: number | null;
  transcriptUrl?: string;
  transcriptType?: string;
  link?: string;
  alternateEnclosures?: AlternateEnclosure[];
  /** The item's own `<podcast:funding>` links (support links for this track). */
  funding?: FundingLink[];
  /** The item's own `<podcast:value>`, or null when it declares none. Read
   *  from the live feed because Podcast Index can hold a stale one — see
   *  `feedItemValue` (lib/util.ts). */
  value: ValueBlock | null;
  /** The item's `<podcast:valueTimeSplit>` windows. Absent when it has none. */
  valueTimeSplits?: ValueTimeSplit[];
  /** The index of the first `<item>` carrying this guid in the document,
   *  counting items with no guid too: the music sort's tiebreak
   *  (`compareEpisodeOrder`). */
  position: number;
}

export interface RssFeedEnrichment {
  /** One entry for EVERY `<item>` with a guid the scan reached, enriched or
   *  not, so "the feed lists this item" is answerable from `has(guid)`. */
  episodes: Map<string, RssEpisodeEnrichment>;
  /** True when the feed document was read. Every other field is only an
   *  answer about the feed when this is. */
  rssRead?: boolean;
  /** Every guid the feed lists, when the read can vouch for the whole list,
   *  else null (`listedTrackGuids`, lib/util.ts). Absent when not read. */
  listedGuids?: ReadonlySet<string> | null;
  /** The channel `<podcast:value>`, or null when the channel declares none. */
  feedValue?: ValueBlock | null;
  feedMedium?: string;
  feedPodroll?: PodrollItem[];
  feedFunding?: FundingLink[];
  feedNostrNpubs?: FeedNpub[];
  /** The artist feed the channel names (`parsePublisherRef`). */
  feedPublisher?: { feedGuid: string; feedUrl: string };
  /** The channel `<title>`, for the case where Podcast Index holds a BLANK one.
   *  See the backfills in app/api/feed/route.ts. */
  feedTitle?: string;
}

// --- <podcast:transcript> selection ---------------------------------------
// A single episode may carry several transcript formats. We keep just one — the
// best *timed* one for the synced player view — ranked JSON > SRT > VTT, with
// untimed (html/plain) a last resort. The client parser (lib/transcript.ts)
// branches on the chosen MIME type.
function inferTranscriptType(url: string): string | undefined {
  const path = url.split(/[?#]/, 1)[0].toLowerCase();
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.srt')) return 'application/x-subrip';
  if (path.endsWith('.vtt')) return 'text/vtt';
  if (path.endsWith('.html') || path.endsWith('.htm')) return 'text/html';
  if (path.endsWith('.txt')) return 'text/plain';
  return undefined;
}

function transcriptRank(type: string | undefined): number {
  const t = (type ?? '').toLowerCase();
  if (t.includes('json')) return 0;
  if (t.includes('subrip') || t.includes('srt')) return 1;
  if (t.includes('vtt')) return 2;
  return 3; // html / plain / unknown — untimed, readable fallback
}

function pickBestTranscript(
  entries: { url: string; type?: string }[],
): { transcriptUrl?: string; transcriptType?: string } {
  let best: { url: string; type?: string } | undefined;
  let bestRank = Infinity;
  for (const e of entries) {
    if (!e.url) continue;
    const type = e.type || inferTranscriptType(e.url);
    const rank = transcriptRank(type);
    if (rank < bestRank) {
      best = { url: e.url, type };
      bestRank = rank;
    }
  }
  return best ? { transcriptUrl: best.url, transcriptType: best.type } : {};
}

// PI exposes transcripts either as a `transcripts` array ({ url, type }) or a
// single `transcriptUrl` string, depending on endpoint. Take whatever's there.
function transcriptFromPi(e: any): { transcriptUrl?: string; transcriptType?: string } {
  const entries: { url: string; type?: string }[] = [];
  if (Array.isArray(e.transcripts)) {
    for (const t of e.transcripts) {
      if (typeof t?.url === 'string' && t.url) {
        entries.push({ url: t.url, type: typeof t.type === 'string' ? t.type : undefined });
      }
    }
  }
  if (typeof e.transcriptUrl === 'string' && e.transcriptUrl) {
    entries.push({
      url: e.transcriptUrl,
      type: typeof e.transcriptType === 'string' ? e.transcriptType : undefined,
    });
  }
  return pickBestTranscript(entries);
}

// Parse an item's <podcast:transcript url type /> tags and pick the best one.
function parseTranscripts(inner: string): { transcriptUrl?: string; transcriptType?: string } {
  const entries: { url: string; type?: string }[] = [];
  for (const { attrs } of findTags(inner, 'podcast:transcript')) {
    const url = readAttr(attrs, 'url');
    if (!url) continue;
    entries.push({ url, type: readAttr(attrs, 'type') });
  }
  return pickBestTranscript(entries);
}

// Parse an item's <podcast:alternateEnclosure> blocks. Each block wraps one or
// more <podcast:source uri> mirrors; we keep the first usable https(-ish) source
// per block. PI doesn't index the tag, so this is RSS-only. The URLs are played
// directly by the browser <audio>/<video> (like the standard enclosure), so no
// server-side fetch / SSRF surface here.
function parseAlternateEnclosures(inner: string): AlternateEnclosure[] | undefined {
  const out: AlternateEnclosure[] = [];
  for (const hit of findBlocks(inner, 'podcast:alternateEnclosure')) {
    // A self-closing block lists no <podcast:source>, so there is nothing to play.
    if (hit.selfClosing) continue;
    const attrs = hit.attrs;
    const body = hit.inner;
    // Collect all <podcast:source uri> mirrors (with their contentType), then
    // prefer an https URL.
    const sources: { uri: string; contentType?: string }[] = [];
    for (const src of findTags(body, 'podcast:source')) {
      const uri = readAttr(src.attrs, 'uri');
      if (uri) sources.push({ uri, contentType: readAttr(src.attrs, 'contentType') });
    }
    const chosen = sources.find((s) => /^https:/i.test(s.uri)) ?? sources[0];
    if (!chosen) continue;
    const num = (name: string): number | undefined => {
      const raw = readAttr(attrs, name);
      if (raw == null || raw === '') return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    out.push({
      // `type` is required on the block per spec, but fall back to the chosen
      // source's contentType so a feed that only tags the <source> still resolves.
      type: readAttr(attrs, 'type') ?? chosen.contentType,
      title: readAttr(attrs, 'title'),
      source: chosen.uri,
      length: num('length'),
      bitrate: num('bitrate'),
      height: num('height'),
      default: readAttr(attrs, 'default')?.toLowerCase() === 'true',
    });
  }
  return out.length ? out : undefined;
}

// Parse channel-level <podcast:funding url="...">message</podcast:funding>
// entries (both paired and self-closing forms). PI usually indexes one; RSS may
// carry several.
function parseFunding(channelXml: string): FundingLink[] | undefined {
  const out: FundingLink[] = [];
  for (const hit of findBlocks(channelXml, 'podcast:funding')) {
    // Through `httpUrl`, for the same reason `parseLiveValue` does it: this is
    // an attacker-chosen attribute that ends up as a live `href` on the SUPPORT
    // button, and **React does not block a `javascript:` href — it only warns
    // in dev**. This origin's localStorage holds the NWC spending credential
    // and the nsec, so one press of a feed's own support link would run the
    // feed author's script against the user's wallet. The allowlist fails
    // closed: an unparseable or non-http(s) url drops the entry entirely,
    // which renders no button rather than a dead one.
    //
    // At the PARSE boundary rather than at the two render sites, so a third
    // surface that shows a funding link inherits the guard instead of
    // re-deciding it.
    const url = httpUrl(readAttr(hit.attrs, 'url'));
    if (!url) continue;
    const message = hit.selfClosing ? '' : decodeXmlText(hit.inner);
    out.push({ url, message: message || undefined });
  }
  return out.length ? out : undefined;
}

// PI returns `funding` as a single { url, message } object (occasionally an
// array). Normalize to our FundingLink[].
function fundingFromPi(f: any): FundingLink[] | undefined {
  const raw = Array.isArray(f.funding) ? f.funding : f.funding ? [f.funding] : [];
  const out: FundingLink[] = [];
  for (const x of raw) {
    // Same allowlist as `parseFunding` above, and needed just as much: Podcast
    // Index mirrors the feed's attribute verbatim, so PI is a carrier of the
    // feed author's string rather than a filter on it.
    const url = httpUrl(typeof x?.url === 'string' ? x.url : undefined);
    if (url) {
      out.push({ url, message: typeof x.message === 'string' && x.message ? x.message : undefined });
    }
  }
  return out.length ? out : undefined;
}

// Parse a channel-level <podcast:podroll> block into its remoteItem entries.
// Same before-first-<item> channel slice + readAttr idiom used for feedMedium.
function parsePodroll(channelXml: string): PodrollItem[] | undefined {
  const block = firstBlock(channelXml, 'podcast:podroll');
  if (!block || block.selfClosing) return undefined;
  const items: PodrollItem[] = [];
  for (const { attrs } of findTags(block.inner, 'podcast:remoteItem')) {
    const feedGuid = readAttr(attrs, 'feedGuid');
    if (!feedGuid) continue;
    items.push({ feedGuid, feedUrl: readAttr(attrs, 'feedUrl') });
  }
  return items.length ? items : undefined;
}

/**
 * Single RSS fetch that extracts <podcast:socialInteract> tags,
 * <content:encoded> show notes, and <podcast:season>/<podcast:episode>
 * track ordering for every <item>, plus the channel-level <podcast:medium>.
 * PI's /episodes/byfeedid exposes none of these, so the feed route merges
 * the result onto the PI-fetched episodes by GUID — one fetch covers all.
 */
export async function getRssEpisodeEnrichment(
  rssUrl: string,
): Promise<RssFeedEnrichment> {
  const episodes = new Map<string, RssEpisodeEnrichment>();
  const xml = await fetchFeedXml(rssUrl);
  if (xml == null) return { episodes };

  // Channel-level podcast:medium (before first <item>)
  const channelXml = channelSlice(xml);
  const feedMedium = extractText(channelXml, 'podcast:medium')?.toLowerCase() || undefined;
  const feedPodroll = parsePodroll(channelXml);
  const feedFunding = parseFunding(channelXml);
  // channelXml, never the raw feed: channelSlice strips <podcast:liveItem>
  // blocks, and a live item carries its own <podcast:txt> — reading that as the
  // show's npub would tag the guest of one broadcast on every boost forever.
  const feedNostrNpubs = parseFeedNpubs(channelXml);
  const feedTitle = extractText(channelXml, 'title') || undefined;
  const feedPublisher = parsePublisherRef(channelXml);

  // Every item's guid in document order, a missing one included, so the route
  // can tell a feed that lists every row from one this scan cannot vouch for.
  const itemGuids: (string | undefined)[] = [];
  for (const item of findBlocks(xml, 'item', { max: MAX_RSS_ITEMS })) {
    const inner = item.inner;
    const guid = extractText(inner, 'guid');
    const position = itemGuids.length;
    itemGuids.push(guid || undefined);
    if (!guid) continue;
    const socialInteract = parseSocialInteractsFromRss(inner) ?? undefined;
    // Full show notes: prefer <content:encoded>; when a feed doesn't use it
    // (e.g. Podcasting 2.0's own feed), fall back to the item <description>,
    // which holds the full HTML. PI's `description` is the same field but
    // truncated (~3000 chars, mid-word) and tag-stripped, so this untruncated,
    // link-preserving version is strictly better and the detail view prefers it.
    const raw = extractRawContent(inner, 'content:encoded') ?? extractRawContent(inner, 'description');
    const contentEncoded = raw ? sanitizeShowNotes(raw) || undefined : undefined;
    const { season, episode } = parseSeasonEpisode(inner);
    const { transcriptUrl, transcriptType } = parseTranscripts(inner);
    // Item <link> — the episode web page (RSS <link>, not <atom:link>). Full
    // notes often live here when the feed's <description> is abbreviated.
    const link = extractText(inner, 'link') || undefined;
    // <podcast:alternateEnclosure> — alternate renditions (e.g. a video version).
    const alternateEnclosures = parseAlternateEnclosures(inner);
    // <podcast:txt purpose="nostr"> — this track's/episode's own artist.
    const nostrNpubs = parseFeedNpubs(inner);
    // <podcast:funding> may sit in an <item> too — this track's own support
    // link. Same parser, same httpUrl guard, as the channel's.
    const funding = parseFunding(inner);
    // The item's own value block, read here because Podcast Index can hold a
    // stale one. Every item gets an entry, enriched or not, so the route can
    // tell "the feed lists this item and gives it no block" from "the scan
    // never reached it" — only the first is an answer about the payee.
    const value = parseValueBlock(inner);
    // Who gets paid during a song, for the same reason. Guarded so a long feed
    // with no windows does not run the block scan once per item.
    const valueTimeSplits = inner.includes(VALUE_TIME_SPLIT_TAG) ? itemValueTimeSplits(inner) : undefined;
    // The file this item plays, for the same reason: PI's `enclosureUrl` can be
    // a crawl from years ago that lacks the publisher's analytics prefix
    // (`op3.dev/e,pg=…/`). `feedEnclosure` decides whether it ships.
    const { enclosureUrl, enclosureType, enclosureLength } = parseItemEnclosure(inner);
    // A feed that repeats a guid keeps the later item's fields, as it always
    // did, and the FIRST item's place.
    const firstAt = episodes.get(guid)?.position ?? position;
    episodes.set(guid, { enclosureUrl, enclosureType, enclosureLength, socialInteract, contentEncoded, season, episode, transcriptUrl, transcriptType, link, alternateEnclosures, nostrNpubs, funding, value, valueTimeSplits, position: firstAt });
  }
  const feedValue = parseValueBlock(channelXml);
  const listedGuids = listedTrackGuids(itemGuids, itemGuids.length >= MAX_RSS_ITEMS);
  return { episodes, rssRead: true, listedGuids, feedValue, feedMedium, feedPodroll, feedFunding, feedNostrNpubs, feedTitle, feedPublisher };
}

// --- Non-PI feed preview ---------------------------------------------------
// Build a full { podcast, episodes } straight from raw RSS, bypassing Podcast
// Index entirely. Used when a publisher pastes a feed URL that PI doesn't index
// yet, so they can preview how the feed displays before submitting it. Reuses
// every RSS extractor above; the only new parsing is enclosure/pubDate/duration,
// which PI normally supplies.
//
// The feed gets a NEGATIVE synthetic id (-fnvHash(url)) — the same "not a real
// PI feed" convention live items and Nostr streams use — and NO podcastGuid,
// which keeps it out of favorites/share/Nostr and URL mirroring. Returns null
// when the URL isn't fetchable or doesn't look like an RSS feed (e.g. a pasted
// HTML page).

// <itunes:duration>: raw seconds ("1387") OR H:MM:SS / MM:SS clock form. The
// rest of the app treats Episode.duration as seconds, so a naive Number() on
// "23:07" (→ NaN) would break the duration display.
/**
 * `<podcast:season>` / `<podcast:episode>` for one `<item>`, as the disc/track
 * pair the rest of the app sorts music feeds by.
 *
 * Per spec the season number rides on a `number` ATTRIBUTE and takes precedence
 * over the tag's text content, while the episode number is plain text — hence
 * the asymmetry, which is not a bug.
 *
 * Shared because this was written out twice in this file, and the two copies
 * had already DRIFTED: only `getFeedFromRss` carried the `<itunes:episode>`
 * fallback, so a feed that numbers its items the iTunes way was ordered
 * correctly in the raw-RSS preview and arbitrarily in the PI-backed path.
 * `Episode.episode` in lib/types.ts is documented as
 * "`<podcast:episode>` / `<itunes:episode>` if present", so the enrichment copy
 * was the one out of step with stated intent — unified onto the fallback.
 *
 * `Number(s) || null` deliberately maps both a non-numeric string and a literal
 * 0 to null; item numbering is 1-based, so a 0 here means the feed wrote
 * something we can't use.
 */
function parseSeasonEpisode(inner: string): { season: number | null; episode: number | null } {
  const seasonTag = firstTag(inner, 'podcast:season');
  const seasonStr = (seasonTag ? readAttr(seasonTag.attrs, 'number') : undefined)
    ?? extractText(inner, 'podcast:season');
  const episodeStr = extractText(inner, 'podcast:episode') ?? extractText(inner, 'itunes:episode');
  return {
    season: seasonStr != null && seasonStr !== '' ? (Number(seasonStr) || null) : null,
    episode: episodeStr != null && episodeStr !== '' ? (Number(episodeStr) || null) : null,
  };
}

function parseItunesDuration(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (/^\d+$/.test(s)) return Number(s) || undefined;
  if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(s)) {
    const secs = s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
    return Number.isFinite(secs) && secs > 0 ? secs : undefined;
  }
  return undefined;
}

// <pubDate> (RFC-822) → unix seconds. Date.parse handles most real-world forms;
// non-standard strings yield NaN, which we drop (the app multiplies by 1000).
function parsePubDate(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

// Artwork for a channel or item: prefer <itunes:image href>, fall back to the
// RSS <image><url> block (same two-source fallback as musicl-resolver).
function extractItunesImageHref(xml: string): string | undefined {
  const tag = firstTag(xml, 'itunes:image');
  return tag ? readAttr(tag.attrs, 'href') : undefined;
}
function extractRssImageUrl(xml: string): string | undefined {
  const image = firstBlock(xml, 'image');
  if (!image || image.selfClosing) return undefined;
  const url = firstBlock(image.inner, 'url');
  if (!url || url.selfClosing) return undefined;
  const text = decodeXmlText(url.inner);
  return text || undefined;
}

/**
 * The channel half of a not-in-PI feed, as a `Podcast`.
 *
 * Shared by `getFeedFromRss` and `getPlaylistChannel` rather than written out
 * twice: the two paths must agree about what the same document is called, what
 * art it has and — the one that matters — that a preview feed carries a
 * SYNTHETIC negative id and **no `podcastGuid`**.
 *
 * Withholding the guid is deliberate even though a `musicL` playlist does
 * publish a `<podcast:guid>`. This function has not asked Podcast Index
 * anything, so it cannot know the guid resolves — and a feed favorite writes
 * that guid to a shared kind:10333 list with no undo, where an unresolvable one
 * is an unopenable placeholder forever. The guid being present on the wire is
 * not the test; being resolvable is.
 *
 * **`isPreview` here therefore means "this record was built without asking PI",
 * NOT "PI does not hold this feed" — a caller that renders it as the second
 * must establish the second itself.** Playlists are routinely indexed: nine of
 * the ten in ChadF's collection are, and `/api/playlist` shipped stamping every
 * one of them NOT IN PI and hiding its favorite heart, because this record's
 * shape was read as an answer about the index. That route now asks
 * `getPodcastByFeedUrl` and merges; any new caller inherits the same duty.
 */
function previewPodcastFromChannel(rssUrl: string, channelXml: string): Podcast {
  const channelRssImage = extractRssImageUrl(channelXml);
  const channelItunesImage = extractItunesImageHref(channelXml);
  const channelImage = channelRssImage ?? channelItunesImage;
  return {
    id: -fnvHash(rssUrl),
    title: extractText(channelXml, 'title') || rssUrl,
    author: extractText(channelXml, 'itunes:author') ?? extractText(channelXml, 'managingEditor'),
    description: extractText(channelXml, 'description'),
    image: channelImage,
    // Keep itunes:image as a second-chance source when it differs from <image>.
    artwork: channelItunesImage && channelItunesImage !== channelImage ? channelItunesImage : undefined,
    url: rssUrl,
    medium: extractText(channelXml, 'podcast:medium')?.toLowerCase() || undefined,
    value: parseValueBlock(channelXml),
    funding: parseFunding(channelXml),
    podroll: parsePodroll(channelXml),
    nostrNpubs: parseFeedNpubs(channelXml),
    publisherFeed: parsePublisherRef(channelXml),
    isPreview: true,
  };
}

/**
 * One RSS `<item>` as an `Episode`, or null when it is not a playable episode
 * (neither a guid nor a media enclosure).
 *
 * Shared by the not-in-PI preview (`getFeedFromRss`) and by the items a
 * PI-backed feed has published since Podcast Index last crawled it
 * (`getRssEpisodesNewerThan`), so the two cannot disagree about what one item
 * is called, when it was published or what id it carries.
 *
 * The id is SYNTHETIC and negative (`-fnvHash(guid)`), the "not a Podcast
 * Index record" convention live items and preview feeds already use.
 * `getRssItemValueTimeSplits` finds the item again by that same number, so
 * the formula lives here once. `value` is the item's OWN block or
 * null — the caller decides the fallback, because the two callers have
 * different ones.
 */
function episodeFromRssItem(inner: string, rssUrl: string, idx: number, feedId: number): Episode | null {
  const guid = extractText(inner, 'guid');
  const enc = firstTag(inner, 'enclosure');
  const enclosureUrl = enc ? readAttr(enc.attrs, 'url') : undefined;
  if (!enclosureUrl && !guid) return null;
  const raw = extractRawContent(inner, 'content:encoded') ?? extractRawContent(inner, 'description');
  const contentEncoded = raw ? sanitizeShowNotes(raw) || undefined : undefined;
  const { season, episode } = parseSeasonEpisode(inner);
  const { transcriptUrl, transcriptType } = parseTranscripts(inner);
  const chaptersTag = firstTag(inner, 'podcast:chapters');
  return {
    id: -fnvHash(guid ?? enclosureUrl ?? `${rssUrl}#${idx}`),
    guid,
    title: extractText(inner, 'title') || 'Untitled',
    description: extractText(inner, 'description'),
    contentEncoded,
    link: extractText(inner, 'link') || undefined,
    enclosureUrl: enclosureUrl ?? '',
    enclosureType: enc ? readAttr(enc.attrs, 'type') : undefined,
    enclosureLength: numOrUndef(enc ? readAttr(enc.attrs, 'length') : undefined),
    alternateEnclosures: parseAlternateEnclosures(inner),
    duration: parseItunesDuration(extractText(inner, 'itunes:duration')),
    datePublished: parsePubDate(extractText(inner, 'pubDate')),
    image: extractItunesImageHref(inner) ?? extractRssImageUrl(inner),
    feedId,
    season,
    episode,
    chaptersUrl: chaptersTag ? readAttr(chaptersTag.attrs, 'url') : undefined,
    transcriptUrl,
    transcriptType,
    value: parseValueBlock(inner),
    socialInteract: parseSocialInteractsFromRss(inner),
    nostrNpubs: parseFeedNpubs(inner),
    funding: parseFunding(inner),
  };
}

export async function getFeedFromRss(
  rssUrl: string,
): Promise<{ podcast: Podcast; episodes: Episode[] } | null> {
  const xml = await fetchFeedXml(rssUrl);
  if (xml == null) return null;
  // Guard against a non-feed URL (e.g. an HTML page pasted by mistake): a real
  // RSS feed has a <channel> and/or at least one <item>.
  if (!/<channel\b/i.test(xml) && !/<item\b/i.test(xml)) return null;

  const channelXml = channelSlice(xml);

  const podcast = previewPodcastFromChannel(rssUrl, channelXml);
  const feedId = podcast.id;
  const medium = podcast.medium;

  const episodes: Episode[] = [];
  let idx = 0;
  for (const item of findBlocks(xml, 'item', { max: MAX_RSS_ITEMS })) {
    const ep = episodeFromRssItem(item.inner, rssUrl, idx++, feedId);
    // Episode value block, else the channel's (matches /api/feed's fallback).
    if (ep) episodes.push({ ...ep, value: ep.value ?? podcast.value });
  }

  // Music album feeds sort by disc (podcast:season) then track (podcast:episode)
  // ascending; everything else newest-first. `compareEpisodeOrder` is shared
  // with /api/feed rather than restated here — the two used to be separate
  // copies of this rule, each citing the other.
  episodes.sort(compareEpisodeOrder(medium === 'music'));

  return { podcast, episodes };
}

/**
 * Items the feed has published since Podcast Index last crawled it.
 *
 * `/api/feed` builds its list from PI, and PI crawls on its own schedule — a
 * feed that sends no podping can wait a day or more. Measured 2026-09-23 on
 * This Week in Bitcoin (PI feed 6813728): episode 124 was in the RSS at 19:04
 * UTC, PI's last crawl was 2026-09-22 07:03, so the show page stopped at 123
 * while Fountain, which reads the RSS itself, listed 124.
 *
 * Only items dated AFTER `newerThan` (PI's newest) and absent from `known`
 * (the guids PI returned) are taken. The date bound is the point: past it the
 * gap is "PI has not crawled yet", while an OLD item PI lacks is PI's own
 * decision or its 1000-item ceiling, and appending those would reorder an
 * archive show's history. An item needs a guid AND an enclosure — without a
 * guid it cannot be favorited, found again by `/api/value-splits`, or deduped
 * against PI once PI catches up.
 *
 * Each carries its `<podcast:valueTimeSplit>` windows, because the boost modal
 * reads them to decide that a song is playing. Without them a boost inside a
 * song pays the show and says nothing. `value` is the item's own block or null;
 * the route applies the feed's channel fallback (`feedItemValue`).
 *
 * Goes through `fetchFeedXml`, so right after `getRssEpisodeEnrichment` this is
 * a cache hit, not a second download.
 */
export async function getRssEpisodesNewerThan(
  rssUrl: string,
  feedId: number,
  newerThan: number,
  known: ReadonlySet<string>,
): Promise<Episode[]> {
  const xml = await fetchFeedXml(rssUrl);
  if (xml == null) return [];
  const out: Episode[] = [];
  let idx = 0;
  for (const item of findBlocks(xml, 'item', { max: MAX_RSS_ITEMS })) {
    const i = idx++;
    // Cheap tests first: the full build sanitizes show notes, and almost every
    // item of a PI-crawled feed is one PI already returned.
    const guid = extractText(item.inner, 'guid');
    if (!guid || known.has(guid)) continue;
    const date = parsePubDate(extractText(item.inner, 'pubDate'));
    if (date == null || date <= newerThan) continue;
    const ep = episodeFromRssItem(item.inner, rssUrl, i, feedId);
    if (!ep || !ep.enclosureUrl) continue;
    const valueTimeSplits = itemValueTimeSplits(item.inner);
    out.push(valueTimeSplits.length ? { ...ep, valueTimeSplits } : ep);
  }
  return out;
}

/**
 * The `<podcast:valueTimeSplit>` windows of the RSS item whose synthetic id is
 * `episodeId`, or null when the feed cannot be read or lists no such item.
 *
 * `/api/value-splits` looks episodes up in Podcast Index, which does not hold
 * an item `getRssEpisodesNewerThan` added — so without this, every boost inside
 * a song on a just-published episode would resolve nothing. Matched on the id
 * `episodeFromRssItem` gave it, so the two cannot drift.
 */
export async function getRssItemValueTimeSplits(
  rssUrl: string,
  episodeId: number,
  itemGuid?: string,
): Promise<{ read: false } | { read: true; splits: ValueTimeSplit[] | null }> {
  const xml = await fetchFeedXml(rssUrl).catch(() => null);
  if (xml == null) return { read: false };
  for (const item of findBlocks(xml, 'item', { max: MAX_RSS_ITEMS })) {
    const guid = extractText(item.inner, 'guid');
    if (!guid) continue;
    if (itemGuid ? guid === itemGuid : -fnvHash(guid) === episodeId) {
      return { read: true, splits: itemValueTimeSplits(item.inner) };
    }
  }
  return { read: true, splits: null };
}

/**
 * The payee of one item, out of its parent feed: the item's own block, else the
 * channel's, else `null`. `{ read: false }` means the document never arrived,
 * which is a different answer from a feed that names nobody.
 *
 * An item the scan does not find still inherits the channel, because that is
 * what the feed says about any item with no block of its own. **A playlist or
 * publisher feed is the exception:** its channel block belongs to the curator, so
 * it never stands in for a track it merely lists (`payableValue`).
 */
export async function getItemPaymentFromRss(rssUrl: string, itemGuid: string): Promise<ItemPayment> {
  const xml = await fetchFeedXml(rssUrl).catch(() => null);
  if (xml == null) return { read: false };
  const channelXml = channelSlice(xml);
  const medium = extractText(channelXml, 'podcast:medium');
  const listsOthers = isPlaylistMedium({ medium }) || medium?.toLowerCase() === 'publisher';
  const channel = listsOthers ? null : parseValueBlock(channelXml);
  for (const item of findBlocks(xml, 'item', { max: MAX_RSS_ITEMS })) {
    if (extractText(item.inner, 'guid') !== itemGuid) continue;
    return {
      read: true,
      value: parseValueBlock(item.inner) ?? channel,
      valueTimeSplits: itemValueTimeSplits(item.inner),
      // A video rendition, for an episode Podcast Index built: this read is the
      // only one it gets, at play time. See `ItemPayment.alternateEnclosures`.
      alternateEnclosures: parseAlternateEnclosures(item.inner),
    };
  }
  return { read: true, value: channel, valueTimeSplits: [] };
}

/** A `musicL` playlist's channel metadata and its track references. */
export interface PlaylistChannel {
  podcast: Podcast;
  /** Deduped, in wire order. See `parsePlaylistRemoteItems`. */
  refs: PlaylistItemRef[];
  /** `<podcast:txt purpose="source-feed">` — see `parsePlaylistSourceFeed`. */
  sourceFeedUrl?: string;
}

/**
 * Read a `<podcast:medium>musicL</podcast:medium>` playlist feed.
 *
 * Returns the channel as a preview `Podcast` plus the whole (deduped) track
 * reference list — **not** the tracks themselves. Resolving a reference costs a
 * Podcast Index lookup each, and a real playlist holds four figures of them, so
 * the fan-out belongs to a caller that can page it (`app/api/playlist`), not
 * to the parser.
 *
 * Returns null for a document that is not a playlist, which is two distinct
 * refusals collapsed on purpose: an unfetchable URL, and a feed that simply
 * isn't one. Both mean "there is no playlist here", and the caller's answer to
 * each is the same 404.
 *
 * The medium gate is a gate, not a hint: a feed that publishes ordinary
 * `<item>` elements is served by `getFeedFromRss`, and reading its podroll or a
 * stray remote item as a track list would manufacture songs the publisher never
 * listed. `refs` being empty is a valid playlist that is empty, and is left for
 * the caller to render as such.
 *
 * Goes through the shared `fetchFeedXml`, so paging N times over one document
 * costs one upstream fetch inside the 60 s window rather than N.
 */
export async function getPlaylistChannel(rssUrl: string): Promise<PlaylistChannel | null> {
  const xml = await fetchFeedXml(rssUrl);
  if (xml == null) return null;
  if (!/<channel\b/i.test(xml)) return null;
  const channelXml = channelSlice(xml);
  const podcast = previewPodcastFromChannel(rssUrl, channelXml);
  if (!isPlaylistMedium(podcast)) return null;
  return {
    podcast,
    refs: parsePlaylistRemoteItems(channelXml),
    sourceFeedUrl: parsePlaylistSourceFeed(channelXml),
  };
}

/**
 * The TITLE of the show a playlist was built from, or null.
 *
 * The playlist's episode markers are bare titles — "Saddle Up", "Cycles" — and
 * on screen they read as random words with nothing saying what they are. The
 * show's own name is the missing context, and the only authority for it is the
 * source feed's `<title>`.
 *
 * One fetch, and it is affordable because of where it lands rather than
 * because it is small: these feeds are 350-520 KB, but `fetchFeedXml` holds a
 * bounded module cache and `/api/playlist` is CDN-cached on top, so a whole
 * playlist's thirteen pages share one read and most requests never reach this
 * process at all. Deliberately NOT a Podcast Index lookup: PI would be a second
 * quota call for a string the document already carries, on the one path where
 * a rate limit is already the thing that hurts.
 *
 * Never throws. A source feed that is unreachable, or that is not a feed, just
 * costs the heading its qualifier.
 */
export async function getFeedTitle(rssUrl: string): Promise<string | null> {
  const xml = await fetchFeedXml(rssUrl);
  if (xml == null || !/<channel\b/i.test(xml)) return null;
  return extractText(channelSlice(xml), 'title')?.trim() || null;
}

export async function getEpisodeByGuid(
  feedGuid: string,
  itemGuid: string,
): Promise<Episode | null> {
  // PI's /episodes/byguid wants `podcastguid` (lowercase, no camelCase) for
  // the feed identifier. The variable here is named feedGuid because that's
  // what the RSS spec calls it on <podcast:remoteItem feedGuid="...">.
  try {
    const data = await pi<any>(
      `/episodes/byguid?guid=${encodeURIComponent(itemGuid)}&podcastguid=${encodeURIComponent(feedGuid)}`,
    );
    // On the guid, not on `data.episode`. PI can answer a pair it does not hold
    // with 200 and an empty `episode`, which is truthy. `buildEpisode` then makes
    // a record with no guid and no title, and the browser keeps it for seven
    // days, so a note stays without its heart and queue long after PI crawls the
    // item. Measured on a live item and on an episode released hours before.
    // A closed-host item is re-asked on the live same-guid copy (`twinEpisode`).
    return data.episode?.guid ? buildEpisode(await twinEpisode(data.episode, feedGuid, itemGuid)) : null;
  } catch (e) {
    // Same miss-is-not-an-outage rule as getPodcastByFeedUrl above, and it
    // matters more here. PI answers an unindexed pair with **400**
    // `{"status":"false","description":"The parameters given did not resolve
    // to a feed we have in our system."}`. Letting that throw made
    // /api/episode-by-guid return 500, which trips the client-side PI breaker
    // — and favorites hydration resolves episodes probe-first-then-batch, so
    // ONE unindexed track killed the remaining N−1 before they were tried.
    // Observed against a real shared list: 227 episode favorites, 0 rendered,
    // because the first entry was a music feed PI has never crawled.
    // Auth (401/403) and 5xx still throw — those are genuinely breaker-worthy.
    if (isPiMiss(e)) return null;
    throw e;
  }
}

async function resolveOneSplit(split: ValueTimeSplit): Promise<ValueTimeSplit> {
  if (!split.remoteItem?.feedGuid || !split.remoteItem.itemGuid) return split;
  // Podcast Index is the DIRECTORY here: the track's title and art, and the feed
  // URL. The payee only ever comes from the feed. A throw here is how
  // `resolveValueTimeSplits`' probe learns that PI is down.
  const ep = await getEpisodeByGuid(split.remoteItem.feedGuid, split.remoteItem.itemGuid);
  // The track's own length, on EVERY way out below. It is independent of whether
  // the item could be paid: an item PI holds with no value block still has a
  // length, and a song still plays at 1× (`musicHoldSpans`, lib/util.ts).
  const piLength = ep?.duration && ep.duration > 0 ? ep.duration : undefined;
  // What PI's record can say about the track, with no payee: a window whose album
  // feed is gone still shows the song that is playing.
  const named: ValueTimeSplit = {
    ...split,
    ...(ep ? { title: ep.title, image: ep.image, feedId: ep.feedId, feedTitle: ep.feedTitle, episodeGuid: ep.guid } : {}),
    ...(piLength ? { trackDuration: piLength } : {}),
  };
  // The RSS chain covers two more cases on top of the ordinary one:
  //   1. PI knows the feed but hasn't crawled the specific item
  //   2. The host's valueTimeSplit feedGuid points at a publisher feed
  //      (medium=publisher) whose <podcast:remoteItem> entries name the
  //      actual album feed URLs we need to fetch.
  try {
    const feedRes = await pi<any>(
      `/podcasts/byguid?guid=${encodeURIComponent(split.remoteItem.feedGuid)}`,
    );
    // An album on a closed host is read from its live same-guid copy, so the
    // payee comes from the RSS that still answers (Chad, 2026-11-14: payment
    // follows the switch). The dead feed answers 410 and pays no one.
    const feed = await preferLiveTwin(Array.isArray(feedRes.feed) ? feedRes.feed[0] : feedRes.feed);
    const feedUrl: string | undefined = feed?.url;
    if (!feedUrl) return named;
    const rss = await resolveRemoteItemFromRss(feedUrl, split.remoteItem.itemGuid);
    if (!rss) return named;
    const rssLength = piLength ?? parseItunesDuration(rss.durationText);
    return {
      ...named,
      ...(rssLength ? { trackDuration: rssLength } : {}),
      value: rss.value,
      // The ALBUM's title, not the show's, is `feedTitle` — see
      // ValueTimeSplit.feedTitle. Only PI's record can supply it: ResolvedRemoteItem
      // carries no channel title, so it stays undefined rather than being guessed
      // at from the URL.
      title: ep?.title ?? rss.title,
      image: ep?.image ?? rss.image,
      // Case 2 above is the one that matters here: the host's feedGuid named a
      // PUBLISHER, so it is not the track's parent and can't resolve it later.
      // `albumFeedGuid` is the real one when the album declared it, and `null`
      // says "known unresolvable" — which is a different claim from the
      // `undefined` that case 1 leaves behind, where the guid is correct and
      // only PI's crawl is behind. See ValueTimeSplit.parentFeedGuid.
      parentFeedGuid: rss.viaPublisher ? rss.albumFeedGuid ?? null : undefined,
    };
  } catch {
    return named;
  }
}

/** The parent-feed verdict for one remote item, plus the two strings that
 *  name it. */
export interface RemoteItemParent {
  /** See {@link ValueTimeSplit.parentFeedGuid} — the same three states. */
  parentFeedGuid?: string | null;
  /** The ALBUM's title, when the direct lookup supplied one. */
  feedTitle?: string;
  /** The ARTIST — see {@link ValueTimeSplit.artist}. Display-only, and absent
   *  whenever the feed lookup missed or failed. */
  artist?: string;
}

/**
 * Who made this track, out of the feed record for the album it lives in.
 *
 * **Podcast Index puts `author` on the FEED and not on the episode**, so a
 * resolved split knows the track's title and the album's title and still cannot
 * say whose song it is — and on the single-track album feeds most independent
 * releases ship as, those two strings are the SAME string. That is what makes
 * this a second call rather than a field we forgot to map.
 *
 * **It never throws and never delays a verdict it cannot improve.** The artist
 * is a label; the parent-feed answer beside it decides whether a favorite may
 * be written at all. So every failure here — a PI miss, an outage, our own rate
 * limit — is an absent name, never an absent verdict, and `getPodcast`'s
 * unguarded 400 is caught rather than propagated.
 *
 * Three ways in, in order of how sure they are about which feed to ask:
 *   - `feedId` — Podcast Index resolved the item itself and named its feed.
 *   - `parentFeedGuid` — a publisher walk recovered the real album guid.
 *   - the wire `feedGuid` — a direct RSS hit, where the host's guid IS the
 *     album. A publisher walk sets `parentFeedGuid`, so this branch is not the
 *     case where the wire guid names a publisher.
 *
 * `parentFeedGuid === null` is "known unresolvable": there is no album feed to
 * ask, and the publisher's own author is not a promise about this track.
 *
 * **The gate is that the ITEM resolved, not that the FEED did**, and the two
 * come apart in the case that matters. `resolveOneSplit` returns the split
 * untouched when it could not place the track, and a `feedGuid` PI knows beside
 * an `itemGuid` it does not is an ordinary state — an uncrawled release, a
 * host's typo, a guid naming a podcast rather than an album. Asking anyway
 * answers, because the FEED is real: a probe against a made-up all-zeros guid
 * came back `The Four Square Podcast`, a genuine feed that publishes it. That
 * name under a song nobody confirmed is there is a worse row than no name.
 * `split.value` is what both resolve branches set and the give-up return does
 * not.
 */
async function remoteItemArtist(
  split: ValueTimeSplit,
  wireFeedGuid: string,
): Promise<string | undefined> {
  if (!split.value) return undefined;
  if (split.parentFeedGuid === null) return undefined;
  try {
    const feed = split.feedId
      ? await getPodcast(split.feedId)
      : await getPodcastByGuid(split.parentFeedGuid ?? wireFeedGuid);
    const author = feed?.author?.trim();
    if (!author) return undefined;
    // The row already renders the title. A feed whose author repeats it adds a
    // second identical line rather than an answer.
    if (author.toLowerCase() === split.title?.trim().toLowerCase()) return undefined;
    return author;
  } catch {
    return undefined;
  }
}

/**
 * Answer `parentFeedGuid` for one remote item, for a caller that already has a
 * payable value block and needs only the favorite verdict.
 *
 * This exists for the live SOCKET path. A `<podcast:liveValue>` block arrives
 * over a websocket carrying its own recipients, so `lib/v4v/live-value.ts`
 * builds the split client-side and never passes through `resolveOneSplit` the
 * way every RSS signal does. That is correct for the payment — the block is the
 * payment — but it leaves `parentFeedGuid` permanently `undefined`, and a heart
 * offered on that block trusts the host's `feedGuid` verbatim. When the host
 * pointed it at a PUBLISHER feed, the favorite it writes is one no app can ever
 * open, on a shared list with no undo.
 *
 * **It deliberately returns the verdict, not the split.** Handing a resolved
 * `value` block back to a client that already holds the authoritative one is an
 * invitation to pay the wrong thing; there is nothing in this shape a payment
 * could be built from. `feedTitle` and `artist` ride along on the same terms —
 * strings a surface prints, which no caller may pay or key off.
 */
export async function resolveRemoteItemParent(
  feedGuid: string,
  itemGuid: string,
): Promise<RemoteItemParent> {
  const split = await resolveOneSplit({
    startTime: 0,
    duration: 0,
    remoteItem: { feedGuid, itemGuid },
  });
  // Sequential, because which feed to ask is what the resolve just worked out.
  return {
    parentFeedGuid: split.parentFeedGuid,
    feedTitle: split.feedTitle,
    artist: await remoteItemArtist(split, feedGuid),
  };
}

/** Which "now playing" convention a live item turned out to be using. */
export type LiveValueSignal = 'remote-item' | 'value-time-split' | 'value' | 'none';

export interface LiveValueResult {
  split: ValueTimeSplit | null;
  signal: LiveValueSignal;
}

/**
 * Resolve what a live item is playing RIGHT NOW into a payable split.
 *
 * There is no live valueTimeSplit tag: a split is anchored to startTime and
 * duration offsets into a finished enclosure, and a live stream has no
 * absolute time base to sync those to. The convention that ships is that the
 * publisher REWRITES the live item mid-broadcast, so all we can do is read
 * whichever of three shapes they chose and re-read it on a timer.
 *
 * Precedence is `remoteItem > valueTimeSplit > value`. A remoteItem placed in
 * the live item is an explicit "now playing" pointer and means exactly one
 * thing. A rewritten <podcast:value> is the weakest signal because it is
 * indistinguishable from a show that simply has one value block and never
 * changes it — which is why it resolves to `null` here and lets the caller
 * keep using the item's own block, rather than being dressed up as a redirect.
 *
 * A live item carrying MORE THAN ONE valueTimeSplit is ignored entirely. With
 * no time base there is nothing to choose between them, and guessing pays the
 * wrong artist — the one outcome this feature must never produce.
 */
export async function resolveLiveSplit(episode: Episode): Promise<LiveValueResult> {
  const remote = episode.liveRemoteItem;
  if (remote?.feedGuid && remote.itemGuid) {
    const split = await resolveOneSplit({ startTime: 0, duration: 0, remoteItem: remote });
    return { split: split.value ? split : null, signal: 'remote-item' };
  }

  const splits = episode.liveValueTimeSplits ?? [];
  if (splits.length === 1) {
    const only = splits[0];
    // An inline-recipient split is already payable; a remoteItem one needs the
    // same lookup as any other split.
    if (only.value?.recipients?.length) return { split: only, signal: 'value-time-split' };
    if (only.remoteItem?.feedGuid && only.remoteItem.itemGuid) {
      const split = await resolveOneSplit(only);
      return { split: split.value ? split : null, signal: 'value-time-split' };
    }
  }

  if (episode.value?.recipients?.length) return { split: null, signal: 'value' };
  return { split: null, signal: 'none' };
}

// A music episode with a track per valueTimeSplit runs to a few dozen; 200
// leaves room for a long DJ set without letting a hostile feed turn one request
// into an unbounded outbound fan-out.
const MAX_RESOLVED_SPLITS = 200;

export async function resolveValueTimeSplits(
  splits: ValueTimeSplit[],
): Promise<ValueTimeSplit[]> {
  if (splits.length === 0) return [];

  // Probe with the first resolvable split. If it throws, PI is likely down —
  // return everything unresolved rather than firing N more failing calls.
  // Per-call failures inside the fan-out are still caught individually.
  const probeIdx = splits.findIndex(
    (s) => s.remoteItem?.feedGuid && s.remoteItem.itemGuid,
  );
  if (probeIdx === -1) return splits;
  let probeResolved: ValueTimeSplit;
  try {
    probeResolved = await resolveOneSplit(splits[probeIdx]);
  } catch {
    return splits;
  }

  // CAP THE FAN-OUT — but cap the WORK, never the array. `splits` is
  // feed-supplied (PI maps <podcast:valueTimeSplit> wholesale), so its length is
  // attacker-chosen, and each entry can trigger a PI call plus the publisher
  // walk in lib/musicl-resolver.ts. Slicing the RESULT instead would be a bug:
  // callers read this list positionally and `splitAtPosition` walks it to decide
  // which window covers a second, so dropping entries would silently move which
  // artist a boost pays.
  //
  // Over the cap, entries pass through unresolved — the same value the
  // per-entry `catch` already yields, and a case the UI handles: an unresolved
  // remote item falls back to the show's block and says so on screen.
  // ...and cap the CONCURRENCY separately, which the budget above does not do.
  // `budget` decides how many entries are resolved; it says nothing about how
  // many run at once, and `Promise.all` starts all of them. Each one can reach
  // the publisher walk in lib/musicl-resolver.ts, which had the identical hole,
  // so the two multiplied: 200 x 100 outbound fetches from one request, each
  // admitting 8 MB. The item cap and the fan-out cap are two different caps.
  //
  // Walk INDICES rather than splits because `mapLimit` passes only the item —
  // `probeIdx` and the budget are both positional, and widening that signature
  // is not an option: `check:fanout` pins it by running the shipping function.
  const budgeted = new Set<number>();
  for (let i = 0; i < splits.length && budgeted.size < MAX_RESOLVED_SPLITS; i++) {
    if (i !== probeIdx) budgeted.add(i);
  }
  const resolved = await mapLimit(
    splits.map((_, i) => i),
    PI_FANOUT,
    async (i): Promise<ValueTimeSplit> => {
      if (i === probeIdx) return probeResolved;
      if (!budgeted.has(i)) return splits[i];
      try { return await resolveOneSplit(splits[i]); } catch { return splits[i]; }
    },
  );
  if (splits.length > MAX_RESOLVED_SPLITS) {
    console.warn(
      `[pi] episode lists ${splits.length} valueTimeSplits; resolved the first ${MAX_RESOLVED_SPLITS}, rest left unresolved`,
    );
  }
  return resolved;
}

