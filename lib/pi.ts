// Server-side Podcast Index client. Never import from a client component.
import crypto from 'node:crypto';
import type { Podcast, Episode, ValueBlock, ValueRecipient, ValueTimeSplit, SocialInteract } from './types';
import { resolveRemoteItemFromRss } from './musicl-resolver';

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

async function pi<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: authHeaders(),
    // Podcast Index data is fairly cacheable; 60s is sane for search.
    next: { revalidate: 60 },
  });
  if (!res.ok) throw new Error(`PI ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
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
    image: f.image || f.artwork,
    // Keep `artwork` separate so the renderer can try it if `image` 404s —
    // PI maps RSS <image><url> to `image` and <itunes:image> to `artwork`,
    // and the two often disagree (Homegrown Hits has a dead bowlafterbowl
    // <image> but a working <itunes:image>).
    artwork: f.artwork && f.artwork !== f.image ? f.artwork : undefined,
    url: f.url,
    value: normalizeValue(f.value),
  };
}

export async function searchPodcasts(query: string, max = 20): Promise<Podcast[]> {
  const data = await pi<any>(
    `/search/byterm?q=${encodeURIComponent(query)}&max=${max}&fulltext`,
  );
  return (data.feeds ?? []).map(buildPodcast);
}

export async function getPodcast(feedId: number): Promise<Podcast | null> {
  const data = await pi<any>(`/podcasts/byfeedid?id=${feedId}`);
  return data.feed ? buildPodcast(data.feed) : null;
}

export async function getPodcastByGuid(guid: string): Promise<Podcast | null> {
  const data = await pi<any>(`/podcasts/byguid?guid=${encodeURIComponent(guid)}`);
  const f = data.feed;
  if (!f || (Array.isArray(f) && !f.length)) return null;
  // PI returns either a feed object or (rarely) an array; normalize.
  return buildPodcast(Array.isArray(f) ? f[0] : f);
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
    enclosureUrl: e.enclosureUrl,
    enclosureType: e.enclosureType,
    duration: e.duration,
    datePublished: e.datePublished,
    image: e.image || e.feedImage,
    feedId: e.feedId,
    feedTitle: e.feedTitle,
    feedImage: e.feedImage,
    podcastGuid: e.podcastGuid,
    episode: typeof e.episode === 'number' ? e.episode : null,
    season: typeof e.season === 'number' && e.season > 0 ? e.season : null,
    chaptersUrl: typeof e.chaptersUrl === 'string' && e.chaptersUrl.length > 0 ? e.chaptersUrl : undefined,
    value: normalizeValue(e.value),
    valueTimeSplits: parseRawValueTimeSplits(e.timesplits),
    socialInteract: parseNostrSocialInteracts(e.socialInteract),
  };
}

export async function getEpisodes(feedId: number, max = 25): Promise<Episode[]> {
  const data = await pi<any>(
    `/episodes/byfeedid?id=${feedId}&max=${max}&fulltext`,
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

// PI's /episodes/live only indexes currently-broadcasting items; pending
// liveItems live exclusively in the publisher's RSS. Fetch the feed XML
// and pull <podcast:liveItem status="pending|live"> directly.
//
// Hand-rolled regex parser instead of pulling in fast-xml-parser etc — the
// shape we care about (top-level <podcast:liveItem> blocks plus a few
// well-known children) is narrow and stable.
export async function getLiveItemsFromRss(
  rssUrl: string,
  feedId: number,
  podcastGuid?: string,
): Promise<Episode[]> {
  let res: Response;
  try {
    res = await fetch(rssUrl, {
      headers: { 'User-Agent': process.env.APP_NAME ?? 'boostmebitch/0.1' },
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const xml = await res.text();
  return parseRssLiveItems(xml).map((r): Episode => ({
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
  }));
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
    });
  }
  return out;
}

function readAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = attrs.match(re);
  return m ? (m[1] ?? m[2]) : undefined;
}

function parseValueBlock(xml: string): ValueBlock | null {
  const vMatch = xml.match(/<podcast:value\b([^>]*)>([\s\S]*?)<\/podcast:value>/i);
  if (!vMatch) return null;
  const vAttrs = vMatch[1];
  const vInner = vMatch[2];
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

/**
 * Fetch the RSS feed and return a GUID → SocialInteract[] map for every
 * <item> that contains a `<podcast:socialInteract protocol="nostr">` tag.
 * PI's /episodes/byfeedid doesn't expose this field, so the feed API route
 * calls this and merges the result onto the PI-fetched episodes by GUID.
 */
export async function getSocialInteractsFromRss(
  rssUrl: string,
): Promise<Map<string, SocialInteract[]>> {
  const out = new Map<string, SocialInteract[]>();
  let res: Response;
  try {
    res = await fetch(rssUrl, {
      headers: { 'User-Agent': process.env.APP_NAME ?? 'boostmebitch/0.1' },
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return out;
  }
  if (!res.ok) return out;
  const xml = await res.text();
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml))) {
    const inner = m[1];
    const guid = extractText(inner, 'guid');
    if (!guid) continue;
    const social = parseSocialInteractsFromRss(inner);
    if (social?.length) out.set(guid, social);
  }
  return out;
}

export async function getEpisodeByGuid(
  feedGuid: string,
  itemGuid: string,
): Promise<Episode | null> {
  // PI's /episodes/byguid wants `podcastguid` (lowercase, no camelCase) for
  // the feed identifier. The variable here is named feedGuid because that's
  // what the RSS spec calls it on <podcast:remoteItem feedGuid="...">.
  const data = await pi<any>(
    `/episodes/byguid?guid=${encodeURIComponent(itemGuid)}&podcastguid=${encodeURIComponent(feedGuid)}`,
  );
  return data.episode ? buildEpisode(data.episode) : null;
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
    };
  } catch {
    return split;
  }
}

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

  return Promise.all(
    splits.map(async (s, i): Promise<ValueTimeSplit> => {
      if (i === probeIdx) return probeResolved;
      try { return await resolveOneSplit(s); } catch { return s; }
    }),
  );
}

// 32-bit FNV-1a; just need a stable non-colliding key for React + the store.
function fnvHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0x7fffffff;
}
