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

const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedFeed {
  xml: string;
  expires: number;
}
const feedCache = new Map<string, CachedFeed>();

async function fetchFeedXml(url: string): Promise<string | null> {
  const cached = feedCache.get(url);
  if (cached && cached.expires > Date.now()) return cached.xml;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'boostmebitch musicl-resolver' },
    });
    if (!res.ok) return null;
    const xml = await res.text();
    feedCache.set(url, { xml, expires: Date.now() + CACHE_TTL_MS });
    return xml;
  } catch {
    return null;
  }
}

function parseValueRecipients(valueXml: string): ValueRecipient[] {
  const recRe = /<podcast:valueRecipient\b[^/>]*\/?>/g;
  const recipients: ValueRecipient[] = [];
  for (const m of valueXml.matchAll(recRe)) {
    const block = m[0];
    const name = /name="([^"]*)"/.exec(block)?.[1];
    const typeStr = /type="([^"]*)"/.exec(block)?.[1];
    const address = /address="([^"]*)"/.exec(block)?.[1];
    const split = Number(/split="([^"]*)"/.exec(block)?.[1] ?? '0');
    const fee = /fee="true"/i.test(block);
    const customKey = /customKey="([^"]*)"/.exec(block)?.[1];
    const customValue = /customValue="([^"]*)"/.exec(block)?.[1];
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
  const method = /method="([^"]+)"/.exec(valMatch[0])?.[1] || 'keysend';
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
    const imageMatch =
      /<itunes:image[^>]+href="([^"]+)"/.exec(itemXml)
      ?? /<image>[\s\S]*?<url>([^<]+)<\/url>/.exec(itemXml);
    return {
      itemXml,
      title: titleMatch?.[1].trim(),
      image: imageMatch?.[1],
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
    const url = /feedUrl="([^"]+)"/.exec(m[0])?.[1];
    if (url) urls.push(url);
  }
  return urls;
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
  const albumUrls = publisherRemoteItemUrls(xml);
  if (albumUrls.length === 0) return null;

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
