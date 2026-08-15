// Server-side fallback resolver for valueTimeSplits whose remote items
// PI doesn't index. Walks the Podcasting 2.0 publisher → album feed chain:
//
//   1. Host RSS valueTimeSplit ──▶ publisher feedGuid + itemGuid
//   2. Publisher feed (medium=publisher) ──▶ <podcast:remoteItem feedUrl="…"> entries
//   3. Album feed ──▶ contains the actual <item> with the matching <guid> and
//      a <podcast:value> block
//
// PI's /episodes/byguid only finds items it has crawled. Many small-artist
// album feeds aren't in PI, but the publisher feed is — so we fetch the
// publisher RSS to get album feed URLs, then fetch the album RSS to extract
// the value block. Falls back to the album's channel-level value block if
// the item itself has none.

import type { ValueBlock, ValueRecipient } from './types';
import { safeFetch, readCappedText } from './safe-fetch';
import { readAttr } from './feed-xml';

const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 5 * 60 * 1000;
// Matches MAX_PUBLISHER_ALBUMS in app/api/publisher/route.ts — the same walk,
// so the same ceiling. Comfortably above any real publisher's catalogue.
const MAX_ALBUM_FEEDS = 100;

interface CachedFeed {
  xml: string;
  expires: number;
}
// BOUNDED. Keyed by a feed-supplied URL and holding whole RSS bodies, this was
// a plain Map with no eviction — expired entries stopped being served but were
// never deleted, so distinct URLs pinned one body each forever. Same shape and
// same fix as `rssXmlCache` in lib/pi.ts; the two caches are separate only
// because the fetch policies differ (5 min vs 60 s, 5 s vs 8 s).
const FEED_CACHE_MAX = 100;
const feedCache = new Map<string, CachedFeed>();

async function fetchFeedXml(url: string): Promise<string | null> {
  const now = Date.now();
  const cached = feedCache.get(url);
  if (cached && cached.expires > now) return cached.xml;
  try {
    const res = await safeFetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': process.env.APP_NAME ?? 'boostmebitch/0.1' },
    });
    if (!res.ok) return null;
    // Capped for the same reason as lib/pi.ts: the body is retained below.
    const xml = await readCappedText(res);
    for (const [k, v] of feedCache) {
      if (v.expires <= now) feedCache.delete(k);
    }
    // Delete-then-set so a refreshed entry moves to the back of the eviction
    // queue; a plain `set` on an existing key keeps its original position.
    feedCache.delete(url);
    feedCache.set(url, { xml, expires: now + CACHE_TTL_MS });
    while (feedCache.size > FEED_CACHE_MAX) {
      const oldest = feedCache.keys().next();
      if (oldest.done) break;
      feedCache.delete(oldest.value);
    }
    return xml;
  } catch {
    return null;
  }
}

// Attributes are read through `readAttr` (lib/feed-xml.ts), NOT through local
// regexes. The hand-rolled `/address="([^"]*)"/` this replaced had no name
// boundary at all, so it matched the tail of `x-address="…"` and returned an
// attacker's node id in preference to the real `address=` beside it — the same
// payee-substitution `readAttr`'s own comment documents, reached independently
// through a second parser. Two copies of an attribute reader is two places to
// get that wrong; `npm run check:feedxml` pins the one that survives.
function parseValueRecipients(valueXml: string): ValueRecipient[] {
  const recRe = /<podcast:valueRecipient\b[^/>]*\/?>/g;
  const recipients: ValueRecipient[] = [];
  for (const m of valueXml.matchAll(recRe)) {
    const block = m[0];
    const name = readAttr(block, 'name');
    const typeStr = readAttr(block, 'type');
    const address = readAttr(block, 'address');
    const split = Number(readAttr(block, 'split') ?? '0');
    const fee = readAttr(block, 'fee')?.toLowerCase() === 'true';
    const customKey = readAttr(block, 'customKey');
    const customValue = readAttr(block, 'customValue');
    if (!address || (typeStr !== 'node' && typeStr !== 'lnaddress')) continue;
    recipients.push({
      name,
      type: typeStr,
      address,
      split: Number.isFinite(split) ? split : 0,
      fee,
      customKey,
      customValue,
    });
  }
  return recipients;
}

function extractValueBlock(scopeXml: string): ValueBlock | null {
  const valMatch = /<podcast:value\b[^>]*>[\s\S]*?<\/podcast:value>/.exec(scopeXml);
  if (!valMatch) return null;
  const recipients = parseValueRecipients(valMatch[0]);
  if (recipients.length === 0) return null;
  // The OPEN tag only. `valMatch[0]` spans the whole element, so an unanchored
  // read would happily take a `method=` off a nested <podcast:valueRecipient>.
  const openTag = /<podcast:value\b[^>]*>/.exec(valMatch[0])?.[0] ?? '';
  const method = readAttr(openTag, 'method') || 'keysend';
  return { type: 'lightning', method, recipients };
}

interface FoundItem {
  itemXml: string;
  title?: string;
  image?: string;
}

function findItemByGuid(xml: string, itemGuid: string): FoundItem | null {
  // Split on <item> tags. Skip the channel header (slice(1)).
  const itemChunks = xml.split(/<item\b[^>]*>/).slice(1);
  for (const chunk of itemChunks) {
    const closeIdx = chunk.indexOf('</item>');
    if (closeIdx === -1) continue;
    const itemXml = chunk.slice(0, closeIdx);
    // Match guid as the actual <guid> tag content, not a substring elsewhere
    const guidMatch = /<guid\b[^>]*>([^<]+)<\/guid>/.exec(itemXml);
    if (!guidMatch || guidMatch[1].trim() !== itemGuid) continue;
    const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(itemXml);
    const itunesImg = /<itunes:image\b([^>]*)>/.exec(itemXml);
    const image =
      (itunesImg ? readAttr(itunesImg[1], 'href') : undefined)
      ?? /<image>[\s\S]*?<url>([^<]+)<\/url>/.exec(itemXml)?.[1];
    return {
      itemXml,
      title: titleMatch?.[1].trim(),
      image,
    };
  }
  return null;
}

function channelScope(xml: string): string {
  // Everything before the first <item> tag — the channel header where
  // channel-level <podcast:value> lives.
  const firstItem = xml.search(/<item\b[^>]*>/);
  return firstItem === -1 ? xml : xml.slice(0, firstItem);
}

function isPublisherFeed(xml: string): boolean {
  return /<podcast:medium>\s*publisher\s*<\/podcast:medium>/i.test(xml);
}

function publisherRemoteItemUrls(xml: string): string[] {
  const urls: string[] = [];
  const remoteItemRe = /<podcast:remoteItem\b[^>]*>/g;
  for (const m of xml.matchAll(remoteItemRe)) {
    // `readAttr`, not a bare `/feedUrl="…"/`: this URL decides which album feed
    // gets fetched and therefore which value block is paid, so an `x-feedUrl`
    // decoy winning the match is the same payee substitution one level up.
    const url = readAttr(m[0], 'feedUrl');
    if (url) urls.push(url);
  }
  return urls;
}

/** Fetch a publisher feed and return the feedUrls of all its remoteItem album feeds. */
export async function getPublisherAlbumUrls(feedUrl: string): Promise<string[]> {
  const xml = await fetchFeedXml(feedUrl);
  if (!xml || !isPublisherFeed(xml)) return [];
  return publisherRemoteItemUrls(xml);
}

export interface ResolvedRemoteItem {
  value: ValueBlock;
  title?: string;
  image?: string;
}

/**
 * Try to resolve a (feedGuid, itemGuid) remoteItem reference by fetching
 * the source RSS feed directly. Handles two cases:
 *   - feedGuid points at the album feed → find the item, return its value
 *   - feedGuid points at a publisher feed → walk publisher.remoteItems[],
 *     fetch each album feed in parallel, return the first match
 *
 * Returns null if the item can't be located. Uses an in-memory cache so
 * repeated calls within a 5min window don't re-fetch the same RSS.
 *
 * `feedUrl` is supplied separately because PI's /podcasts/byguid is the
 * cheapest way to translate feedGuid → feedUrl, and the caller (lib/pi.ts)
 * already has PI client wiring.
 */
export async function resolveRemoteItemFromRss(
  feedUrl: string,
  itemGuid: string,
): Promise<ResolvedRemoteItem | null> {
  const xml = await fetchFeedXml(feedUrl);
  if (!xml) return null;

  // Direct hit: the feedGuid pointed at an album feed that contains the item
  const direct = findItemByGuid(xml, itemGuid);
  if (direct) {
    const itemValue = extractValueBlock(direct.itemXml);
    if (itemValue) {
      return { value: itemValue, title: direct.title, image: direct.image };
    }
    const channelValue = extractValueBlock(channelScope(xml));
    if (channelValue) {
      return { value: channelValue, title: direct.title, image: direct.image };
    }
  }

  // Publisher chain: walk remoteItems[] for an album feed that contains the item
  if (!isPublisherFeed(xml)) return null;
  const all = publisherRemoteItemUrls(xml);
  if (all.length === 0) return null;

  // CAP THE FAN-OUT. `all` is every <podcast:remoteItem feedUrl> in a
  // third-party publisher feed, so its length is attacker-chosen — one request
  // here turned into N parallel outbound fetches, and this path is reachable
  // from /api/value-splits and /api/live-value, whose own `splits` list is
  // itself feed-supplied. Nested, they multiply.
  //
  // app/api/publisher/route.ts already caps its copy of this walk at
  // MAX_PUBLISHER_ALBUMS; this second path simply never got one.
  const albumUrls = all.slice(0, MAX_ALBUM_FEEDS);
  if (all.length > albumUrls.length) {
    // Say what was dropped. Silent truncation reads as "searched everything",
    // which is how a genuinely missing album becomes an unexplained fallback
    // to the show's value block.
    console.warn(
      `[musicl-resolver] publisher feed lists ${all.length} albums; searching the first ${MAX_ALBUM_FEEDS}`,
    );
  }

  const candidates = await Promise.all(
    albumUrls.map(async (albumUrl): Promise<ResolvedRemoteItem | null> => {
      const albumXml = await fetchFeedXml(albumUrl);
      if (!albumXml) return null;
      const found = findItemByGuid(albumXml, itemGuid);
      if (!found) return null;
      const itemValue = extractValueBlock(found.itemXml);
      if (itemValue) {
        return { value: itemValue, title: found.title, image: found.image };
      }
      const channelValue = extractValueBlock(channelScope(albumXml));
      if (channelValue) {
        return { value: channelValue, title: found.title, image: found.image };
      }
      return null;
    }),
  );

  return candidates.find((c): c is ResolvedRemoteItem => c !== null) ?? null;
}
