// Server-side Podcast Index client. Never import from a client component.
import crypto from 'node:crypto';
import type { Podcast, Episode, ValueBlock, ValueRecipient, ValueTimeSplit, ValueTimeSplitRemoteItem, SocialInteract, PodrollItem, FundingLink, AlternateEnclosure, FeedNpub } from './types';
import { readAttr, decodeXmlText, channelSlice, parseFeedNpubs, parsePlaylistRemoteItems, type PlaylistItemRef } from './feed-xml';
import { resolveRemoteItemFromRss } from './musicl-resolver';
import { safeFetch, readCappedText, MAX_BODY_BYTES } from './safe-fetch';
import { escapeHtmlAttr, safeUrlAttr } from './safe-url-attr';
import { fnvHash, httpUrl, compareEpisodeOrder, splitOnBareUrls, isPlaylistMedium } from './util';
import { createBoundedCache } from './bounded-cache';

const BASE = 'https://api.podcastindex.org/api/1.0';

function authHeaders() {
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
    'User-Agent': process.env.APP_NAME ?? 'boostmebitch/0.1',
  };
}

/** Thrown by `pi()` on a non-2xx, carrying the status so callers can tell a
 *  "PI doesn't know this" miss from a genuine outage. */
export class PiHttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`PI ${status}: ${body}`);
    this.name = 'PiHttpError';
  }
}

async function pi<T>(path: string, maxBytes?: number): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: authHeaders(),
    // Podcast Index data is fairly cacheable; 60s is sane for search.
    next: { revalidate: 60 },
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
  if (!res.ok) throw new PiHttpError(res.status, await readCappedText(res, 4 * 1024));
  return JSON.parse(await readCappedText(res, maxBytes)) as T;
}

// PI's value object → our ValueBlock
function normalizeValue(v: any): ValueBlock | null {
  if (!v?.model || !v?.destinations?.length) return null;
  const recipients: ValueRecipient[] = v.destinations.map((d: any) => ({
    name: d.name,
    type: d.type ?? 'node',
    address: d.address,
    customKey: d.customKey ? String(d.customKey) : undefined,
    customValue: d.customValue ? String(d.customValue) : undefined,
    split: Number(d.split) || 0,
    fee: !!d.fee,
  }));
  return {
    type: v.model.type ?? 'lightning',
    method: v.model.method ?? 'keysend',
    suggested: v.model.suggested,
    recipients,
  };
}

// One canonical mapping from PI feed shape → our Podcast type. Used by every
// fetch endpoint so a new field is added in one place.
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
    value: normalizeValue(f.value),
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
function podcastFromPiFeed(f: any): Podcast | null {
  const feed = Array.isArray(f) ? f[0] : f;
  if (!feed || feed.id == null) return null;
  return buildPodcast(feed);
}

export async function searchPodcasts(query: string, max = 20): Promise<Podcast[]> {
  const data = await pi<any>(
    `/search/byterm?q=${encodeURIComponent(query)}&max=${max}&fulltext`,
  );
  return (data.feeds ?? []).map(buildPodcast);
}

export async function getPodcast(feedId: number): Promise<Podcast | null> {
  const data = await pi<any>(`/podcasts/byfeedid?id=${feedId}`);
  return podcastFromPiFeed(data.feed);
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
    if (e instanceof PiHttpError && (e.status === 400 || e.status === 404)) return null;
    throw e;
  }
}

export async function getPodcastByGuid(guid: string): Promise<Podcast | null> {
  const data = await pi<any>(`/podcasts/byguid?guid=${encodeURIComponent(guid)}`);
  return podcastFromPiFeed(data.feed);
}

// PI exposes valueTimeSplits as a flat top-level `timesplits` array on each
// episode (each entry has feedGuid/itemGuid/medium directly, NOT under a
// nested remoteItem). We keep the consumer-facing ValueTimeSplit shape with
// remoteItem nested because that mirrors the Podcasting 2.0 RSS structure
// and matches how downstream code (boost-all-modal, /api/value-splits) reads
// the data.
function parseRawValueTimeSplits(raw: any): ValueTimeSplit[] {
  if (!Array.isArray(raw) || !raw.length) return [];
  return raw
    .filter((s: any) => s?.feedGuid)
    .map((s: any) => ({
      startTime: Number(s.startTime) || 0,
      duration: Number(s.duration) || 0,
      remoteStartTime: s.remoteStartTime != null ? Number(s.remoteStartTime) : undefined,
      remotePercentage: s.remotePercentage != null ? Number(s.remotePercentage) : undefined,
      remoteItem: {
        feedGuid: s.feedGuid,
        itemGuid: s.itemGuid,
        medium: s.medium || undefined,
      },
    }));
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
  const re = /<podcast:socialInteract\b([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
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
    value: normalizeValue(e.value),
    valueTimeSplits: parseRawValueTimeSplits(e.timesplits),
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

// PI exposes liveItem records globally at /episodes/live. There is no per-feed
// endpoint, so we pull a wide page and filter. PI's status field can be
// 'live' | 'pending' | 'ended'; we drop ended — old broadcasts shouldn't
// crowd the top of the episode list.
export async function getLiveItemsForFeed(feedId: number): Promise<Episode[]> {
  const data = await pi<any>(`/episodes/live?max=1000`);
  const out: Episode[] = [];
  for (const e of data.items ?? []) {
    if (Number(e.feedId) !== feedId) continue;
    const status = typeof e.status === 'string' ? e.status.toLowerCase() : undefined;
    if (status !== 'live' && status !== 'pending') continue;
    out.push({
      ...buildEpisode(e),
      liveStatus: status,
      liveStartTime: typeof e.startTime === 'number' ? e.startTime : undefined,
    });
  }
  return out;
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
//   - within FRESH window: serve cached XML without refetching (matches the
//     `next: { revalidate: 60 }` below, so this and Next's data cache align).
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
// The sweep/delete-then-set/cap bookkeeping is `createBoundedCache`, shared with
// lib/musicl-resolver.ts — both caches shipped the same unbounded-growth bug
// because the mechanism had been copied. Only the POLICY is local: the horizon
// here is the stale window (not the fresh one), because a body past 60 s is
// still servable on a failed refetch and must not be swept until 10 min.
const rssXmlCache = createBoundedCache<string>({
  maxAgeMs: RSS_STALE_MS,
  maxEntries: RSS_CACHE_MAX,
});

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
      headers: { 'User-Agent': process.env.APP_NAME ?? 'boostmebitch/0.1' },
      next: { revalidate: Math.max(1, Math.floor(freshMs / 1000)) },
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
  const xml = await fetchFeedXml(rssUrl, opts);
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
    value: r.value,
    socialInteract: r.socialInteract,
    liveValue: r.liveValue,
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

interface RawLiveItem {
  status: 'pending' | 'live';
  startTime?: number;
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
  const m = xml.match(/<podcast:liveValue\b([^>]*?)\/?>/i);
  if (!m) return undefined;
  const uri = httpUrl(readAttr(m[1], 'uri'));
  if (!uri) return undefined;
  return { uri, protocol: (readAttr(m[1], 'protocol') || '').toLowerCase() };
}

function parseRssLiveItems(xml: string): RawLiveItem[] {
  const out: RawLiveItem[] = [];
  const blockRe = /<podcast:liveItem\b([^>]*)>([\s\S]*?)<\/podcast:liveItem>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml))) {
    const attrs = m[1];
    const inner = m[2];
    const rawStatus = readAttr(attrs, 'status')?.toLowerCase();
    if (rawStatus !== 'pending' && rawStatus !== 'live') continue;
    const startStr = readAttr(attrs, 'start');
    const startMs = startStr ? Date.parse(startStr) : NaN;
    const startTime = Number.isFinite(startMs) ? Math.floor(startMs / 1000) : undefined;
    const enc = inner.match(/<enclosure\b([^>]*?)\/?>/i);
    const itunesImg = inner.match(/<itunes:image\b([^>]*?)\/?>/i);
    out.push({
      status: rawStatus,
      startTime,
      title: extractText(inner, 'title'),
      description: extractText(inner, 'description'),
      guid: extractText(inner, 'guid'),
      enclosureUrl: enc ? readAttr(enc[1], 'url') : undefined,
      enclosureType: enc ? readAttr(enc[1], 'type') : undefined,
      image: itunesImg ? readAttr(itunesImg[1], 'href') : undefined,
      value: parseValueBlock(inner),
      socialInteract: parseSocialInteractsFromRss(inner),
      // The "now playing" signals. A remoteItem placed directly in the live
      // item (i.e. not one nested inside a valueTimeSplit) is the explicit
      // pointer; splits are the fallback. Both are read here so the resolver
      // can apply precedence in one place.
      remoteItem: firstRemoteItem(stripValueTimeSplits(inner)),
      valueTimeSplits: parseValueTimeSplitsFromRss(inner),
      liveValue: parseLiveValue(inner),
    });
  }
  return out;
}

function parseValueBlock(xml: string): ValueBlock | null {
  const vMatch = xml.match(/<podcast:value\b([^>]*)>([\s\S]*?)<\/podcast:value>/i);
  if (!vMatch) return null;
  const vAttrs = vMatch[1];
  // <podcast:valueTimeSplit> is a CHILD of <podcast:value>, and it may carry
  // its own inline <podcast:valueRecipient> tags. Strip those blocks before
  // scanning, or a split's recipients get merged into the block's own — the
  // show would pay a guest's segment splits for the whole episode.
  const vInner = stripValueTimeSplits(vMatch[2]);
  const recipients: ValueRecipient[] = [];
  const recipRe = /<podcast:valueRecipient\b([^>]*?)\/?>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = recipRe.exec(vInner))) {
    const ra = rm[1];
    const address = readAttr(ra, 'address');
    if (!address) continue;
    recipients.push({
      name: readAttr(ra, 'name'),
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

const VALUE_TIME_SPLIT_RE = /<podcast:valueTimeSplit\b([^>]*?)(?:\/>|>([\s\S]*?)<\/podcast:valueTimeSplit>)/gi;

function stripValueTimeSplits(xml: string): string {
  return xml.replace(VALUE_TIME_SPLIT_RE, '');
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
  const m = xml.match(/<podcast:remoteItem\b([^>]*?)\/?>/i);
  return (m && parseRemoteItem(m[1])) || undefined;
}

/**
 * Parse <podcast:valueTimeSplit> children out of raw RSS.
 *
 * Podcast Index surfaces splits as its own flat `timesplits` JSON (see
 * parseRawValueTimeSplits), so this is the only path that reads the actual
 * tag — needed because PI never indexes a live item's children. The output
 * shape is deliberately identical to parseRawValueTimeSplits' so downstream
 * code can't tell where a split came from.
 */
function parseValueTimeSplitsFromRss(xml: string): ValueTimeSplit[] {
  const out: ValueTimeSplit[] = [];
  const re = new RegExp(VALUE_TIME_SPLIT_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const inner = m[2] ?? '';
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

function extractText(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return undefined;
  const stripped = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, '$1').trim();
  return stripped
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

// Extract the raw HTML content of a namespaced RSS tag like content:encoded,
// without entity-decoding or tag-stripping. Handles CDATA wrapping.
function extractRawContent(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return undefined;
  const inner = m[1].trim();
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
function decodeMarkupEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function sanitizeShowNotes(html: string): string {
  let out = html;
  // Whole-notes-escaped feeds (e.g. Bowl After Bowl): decode the markup first so
  // <p>/<a>/lists render instead of showing as literal tag text. The allowlist
  // pass below still runs, so decoding can't smuggle anything unsafe.
  if (looksEscapedHtml(out)) out = decodeMarkupEntities(out);
  out = out
    // Feeds that escape only inline emphasis (real <p>/<a> but &lt;b&gt;/&lt;i&gt;,
    // e.g. Podcasting 2.0's own): un-escape a small whitelist so bold/italic render.
    .replace(/&lt;(\/?)(b|strong|i|em|u|s|br)\s*\/?&gt;/gi, '<$1$2>')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(
      /<(script|style|iframe|object|embed|form|input|textarea|select|button|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      '',
    )
    .replace(
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
  return html
    .split(/(<a\b[^>]*>[\s\S]*?<\/a>)/gi)
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
  nostrNpubs?: FeedNpub[];
  socialInteract?: SocialInteract[];
  contentEncoded?: string;
  season?: number | null;
  episode?: number | null;
  transcriptUrl?: string;
  transcriptType?: string;
  link?: string;
  alternateEnclosures?: AlternateEnclosure[];
}

export interface RssFeedEnrichment {
  episodes: Map<string, RssEpisodeEnrichment>;
  feedMedium?: string;
  feedPodroll?: PodrollItem[];
  feedFunding?: FundingLink[];
  feedNostrNpubs?: FeedNpub[];
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
  const re = /<podcast:transcript\b([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    const url = readAttr(m[1], 'url');
    if (!url) continue;
    entries.push({ url, type: readAttr(m[1], 'type') });
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
  const blockRe = /<podcast:alternateEnclosure\b([^>]*)>([\s\S]*?)<\/podcast:alternateEnclosure>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(inner))) {
    const attrs = m[1];
    const body = m[2];
    // Collect all <podcast:source uri> mirrors (with their contentType), then
    // prefer an https URL.
    const sources: { uri: string; contentType?: string }[] = [];
    const srcRe = /<podcast:source\b([^>]*?)\/?>/gi;
    let sm: RegExpExecArray | null;
    while ((sm = srcRe.exec(body))) {
      const uri = readAttr(sm[1], 'uri');
      if (uri) sources.push({ uri, contentType: readAttr(sm[1], 'contentType') });
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
  const re = /<podcast:funding\b([^>]*?)(?:\/>|>([\s\S]*?)<\/podcast:funding>)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(channelXml))) {
    const url = readAttr(m[1], 'url');
    if (!url) continue;
    const message = m[2] != null ? decodeXmlText(m[2]) : '';
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
    if (typeof x?.url === 'string' && x.url) {
      out.push({ url: x.url, message: typeof x.message === 'string' && x.message ? x.message : undefined });
    }
  }
  return out.length ? out : undefined;
}

// Parse a channel-level <podcast:podroll> block into its remoteItem entries.
// Same before-first-<item> channel slice + readAttr idiom used for feedMedium.
function parsePodroll(channelXml: string): PodrollItem[] | undefined {
  const podrollMatch = /<podcast:podroll\b[^>]*>([\s\S]*?)<\/podcast:podroll>/i.exec(channelXml);
  if (!podrollMatch) return undefined;
  const items: PodrollItem[] = [];
  const riRe = /<podcast:remoteItem\b([^>]*?)\/?>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = riRe.exec(podrollMatch[1]))) {
    const feedGuid = readAttr(rm[1], 'feedGuid');
    if (!feedGuid) continue;
    items.push({ feedGuid, feedUrl: readAttr(rm[1], 'feedUrl') });
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

  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml))) {
    const inner = m[1];
    const guid = extractText(inner, 'guid');
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
    if (socialInteract || contentEncoded || season != null || episode != null || transcriptUrl || link || alternateEnclosures || nostrNpubs) {
      episodes.set(guid, { socialInteract, contentEncoded, season, episode, transcriptUrl, transcriptType, link, alternateEnclosures, nostrNpubs });
    }
  }
  return { episodes, feedMedium, feedPodroll, feedFunding, feedNostrNpubs };
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
  const seasonTagMatch = /<podcast:season\b([^>]*)>/i.exec(inner);
  const seasonStr = (seasonTagMatch ? readAttr(seasonTagMatch[1], 'number') : undefined)
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
  const m = xml.match(/<itunes:image\b([^>]*?)\/?>/i);
  return m ? readAttr(m[1], 'href') : undefined;
}
function extractRssImageUrl(xml: string): string | undefined {
  const m = xml.match(/<image\b[^>]*>[\s\S]*?<url>([^<]+)<\/url>/i);
  return m ? decodeXmlText(m[1]) : undefined;
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
 * publish a `<podcast:guid>`. Podcast Index has not indexed these feeds (that
 * is what makes them previews), so `/podcasts/byguid` cannot resolve one on any
 * device — and a feed favorite writes that guid to a shared kind:10333 list
 * with no undo, where it would be an unopenable placeholder forever. The guid
 * being present on the wire is not the test; being resolvable is.
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
    isPreview: true,
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
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = itemRe.exec(xml))) {
    const inner = m[1];
    const guid = extractText(inner, 'guid');
    const enc = inner.match(/<enclosure\b([^>]*?)\/?>/i);
    const enclosureUrl = enc ? readAttr(enc[1], 'url') : undefined;
    // Not a playable episode without either a guid or a media enclosure.
    if (!enclosureUrl && !guid) { idx++; continue; }
    const title = extractText(inner, 'title') || 'Untitled';
    const raw = extractRawContent(inner, 'content:encoded') ?? extractRawContent(inner, 'description');
    const contentEncoded = raw ? sanitizeShowNotes(raw) || undefined : undefined;
    const itemImage = extractItunesImageHref(inner) ?? extractRssImageUrl(inner);
    const { season, episode: episodeNum } = parseSeasonEpisode(inner);
    const { transcriptUrl, transcriptType } = parseTranscripts(inner);
    const chaptersMatch = inner.match(/<podcast:chapters\b([^>]*?)\/?>/i);
    const chaptersUrl = chaptersMatch ? readAttr(chaptersMatch[1], 'url') : undefined;
    const itemValue = parseValueBlock(inner);
    const alternateEnclosures = parseAlternateEnclosures(inner);
    episodes.push({
      id: -fnvHash(guid ?? enclosureUrl ?? `${rssUrl}#${idx}`),
      guid,
      title,
      description: extractText(inner, 'description'),
      contentEncoded,
      link: extractText(inner, 'link') || undefined,
      enclosureUrl: enclosureUrl ?? '',
      enclosureType: enc ? readAttr(enc[1], 'type') : undefined,
      alternateEnclosures,
      duration: parseItunesDuration(extractText(inner, 'itunes:duration')),
      datePublished: parsePubDate(extractText(inner, 'pubDate')),
      image: itemImage,
      feedId,
      season,
      episode: episodeNum,
      chaptersUrl,
      transcriptUrl,
      transcriptType,
      // Episode value block, else the channel's (matches /api/feed's fallback).
      value: itemValue ?? podcast.value,
      socialInteract: parseSocialInteractsFromRss(inner),
      nostrNpubs: parseFeedNpubs(inner),
    });
    idx++;
  }

  // Music album feeds sort by disc (podcast:season) then track (podcast:episode)
  // ascending; everything else newest-first. `compareEpisodeOrder` is shared
  // with /api/feed rather than restated here — the two used to be separate
  // copies of this rule, each citing the other.
  episodes.sort(compareEpisodeOrder(medium === 'music'));

  return { podcast, episodes };
}

/** A `musicL` playlist's channel metadata and its track references. */
export interface PlaylistChannel {
  podcast: Podcast;
  /** Deduped, in wire order. See `parsePlaylistRemoteItems`. */
  refs: PlaylistItemRef[];
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
  return { podcast, refs: parsePlaylistRemoteItems(channelXml) };
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
    return data.episode ? buildEpisode(data.episode) : null;
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
    if (e instanceof PiHttpError && (e.status === 400 || e.status === 404)) return null;
    throw e;
  }
}

async function resolveOneSplit(split: ValueTimeSplit): Promise<ValueTimeSplit> {
  if (!split.remoteItem?.feedGuid || !split.remoteItem.itemGuid) return split;
  const ep = await getEpisodeByGuid(split.remoteItem.feedGuid, split.remoteItem.itemGuid);
  if (ep?.value) {
    return {
      ...split,
      value: ep.value,
      title: ep.title,
      image: ep.image,
      feedId: ep.feedId,
      // The ALBUM's title, not the show's — see ValueTimeSplit.feedTitle. Only
      // this branch can supply it: the RSS fallback below resolves an item out
      // of a feed it may have reached through a publisher chain, and
      // ResolvedRemoteItem carries no channel title, so it stays undefined
      // there rather than being guessed at from the URL.
      feedTitle: ep.feedTitle,
      episodeGuid: ep.guid,
    };
  }
  // PI didn't have the item — try the RSS chain. Two cases this rescues:
  //   1. PI knows the feed but hasn't crawled the specific item
  //   2. The host's valueTimeSplit feedGuid points at a publisher feed
  //      (medium=publisher) whose <podcast:remoteItem> entries name the
  //      actual album feed URLs we need to fetch.
  // Both need the feed URL, which we get cheaply via /podcasts/byguid.
  try {
    const feedRes = await pi<any>(
      `/podcasts/byguid?guid=${encodeURIComponent(split.remoteItem.feedGuid)}`,
    );
    const feedUrl: string | undefined = feedRes.feed?.url;
    if (!feedUrl) return split;
    const rss = await resolveRemoteItemFromRss(feedUrl, split.remoteItem.itemGuid);
    if (!rss) return split;
    return {
      ...split,
      value: rss.value,
      title: rss.title,
      image: rss.image,
      // Case 2 above is the one that matters here: the host's feedGuid named a
      // PUBLISHER, so it is not the track's parent and can't resolve it later.
      // `albumFeedGuid` is the real one when the album declared it, and `null`
      // says "known unresolvable" — which is a different claim from the
      // `undefined` that case 1 leaves behind, where the guid is correct and
      // only PI's crawl is behind. See ValueTimeSplit.parentFeedGuid.
      parentFeedGuid: rss.viaPublisher ? rss.albumFeedGuid ?? null : undefined,
    };
  } catch {
    return split;
  }
}

/** The parent-feed verdict for one remote item, and nothing else. */
export interface RemoteItemParent {
  /** See {@link ValueTimeSplit.parentFeedGuid} — the same three states. */
  parentFeedGuid?: string | null;
  /** The ALBUM's title, when the direct lookup supplied one. */
  feedTitle?: string;
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
 * could be built from.
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
  return { parentFeedGuid: split.parentFeedGuid, feedTitle: split.feedTitle };
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
  let budget = MAX_RESOLVED_SPLITS;
  const resolved = await Promise.all(
    splits.map(async (s, i): Promise<ValueTimeSplit> => {
      if (i === probeIdx) return probeResolved;
      if (budget <= 0) return s;
      budget--;
      try { return await resolveOneSplit(s); } catch { return s; }
    }),
  );
  if (splits.length > MAX_RESOLVED_SPLITS) {
    console.warn(
      `[pi] episode lists ${splits.length} valueTimeSplits; resolved the first ${MAX_RESOLVED_SPLITS}, rest left unresolved`,
    );
  }
  return resolved;
}

