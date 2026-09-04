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
import { createBoundedCache } from './bounded-cache';
import { BRAND } from './brand';
import { mapLimit, FEED_FANOUT } from './util';

const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 5 * 60 * 1000;
// Matches MAX_PUBLISHER_ALBUMS in app/api/publisher/route.ts — the same walk,
// so the same ceiling. Comfortably above any real publisher's catalogue.
const MAX_ALBUM_FEEDS = 100;

// BOUNDED. Keyed by a feed-supplied URL and holding whole RSS bodies, this was
// a plain Map with no eviction — expired entries stopped being served but were
// never deleted, so distinct URLs pinned one body each forever. `rssXmlCache` in
// lib/pi.ts had the identical bug for the identical reason, so the bookkeeping
// now lives once in `createBoundedCache`. The two caches stay SEPARATE
// INSTANCES because the policies genuinely differ: 5 min vs 60 s freshness,
// 5 s vs 8 s fetch timeout, and pi.ts additionally serves stale-on-error.
const FEED_CACHE_MAX = 100;
// Same reasoning as `rssXmlCache` in lib/pi.ts: 100 entries at the 8 MB read
// cap is 800 MB of ceiling, and the publisher walk fills it from one request
// against a feed-supplied URL. The count bounds churn; only this bounds memory.
const FEED_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const feedCache = createBoundedCache<string>({
  maxAgeMs: CACHE_TTL_MS,
  maxEntries: FEED_CACHE_MAX,
  maxBytes: FEED_CACHE_MAX_BYTES,
  sizeOf: (xml) => xml.length,
});

async function fetchFeedXml(url: string): Promise<string | null> {
  const now = Date.now();
  // Horizon and freshness are the same value here (unlike pi.ts, which has no
  // stale-serve path), so anything the cache returns is servable as-is.
  const cached = feedCache.get(url, now);
  if (cached) return cached.value;
  try {
    const res = await safeFetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': process.env.APP_NAME ?? BRAND.userAgent },
    });
    if (!res.ok) return null;
    // Capped for the same reason as lib/pi.ts: the body is retained below.
    const xml = await readCappedText(res);
    feedCache.set(url, xml, now);
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

/**
 * The channel's own `<podcast:guid>` — the album feed's identity.
 *
 * Read from the channel scope only, so an `<item>` carrying its own guid can't
 * be mistaken for the feed's. Element TEXT rather than an attribute, so
 * `readAttr` doesn't apply — but the decoy rule that shaped `readAttr` does:
 * the tag name is anchored to the opening `<`, never matched with `\b`, or a
 * feed writing `<x-podcast:guid>` would satisfy it ahead of the real one.
 *
 * Shape-checked as a UUID because that is what the spec says a feed guid is,
 * and this value's only consumer publishes it to a list other apps read: a
 * malformed one there is an entry nobody can ever resolve. Checked locally
 * rather than by importing `looksLikeFeedGuid` — `lib/nostr/favorites-list.ts`
 * is required to stay import-free and this module is not a dependency it should
 * acquire in either direction.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function channelGuid(xml: string): string | undefined {
  const m = /<podcast:guid[^>]*>([^<]+)<\/podcast:guid>/i.exec(channelScope(xml));
  const v = m?.[1]?.trim();
  return v && UUID_RE.test(v) ? v : undefined;
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

/**
 * The feedUrls of a publisher feed's remoteItem album feeds.
 *
 * **`null` means the feed could not be READ; `[]` means it was read and listed
 * nothing.** They were the same answer, and the difference is the whole
 * sentence on screen: `fetchFeedXml` swallows every failure — a 404, a timeout,
 * a refused scheme, an HTML error page served as 200 — so an unreachable host
 * produced an empty array, `/api/publisher` answered a **cached** 200
 * `{feeds: [], listed: 0}`, and the page printed "this collection lists
 * nothing" about a document nobody had read, held at the edge for five minutes.
 *
 * A document that parses but is not a publisher feed still answers `[]`: that
 * one WAS read, and "it lists no albums" is true of it.
 */
export async function getPublisherAlbumUrls(feedUrl: string): Promise<string[] | null> {
  const xml = await fetchFeedXml(feedUrl);
  if (!xml) return null;
  if (!isPublisherFeed(xml)) return [];
  return publisherRemoteItemUrls(xml);
}

export interface ResolvedRemoteItem {
  value: ValueBlock;
  title?: string;
  image?: string;
  /**
   * True when the item was reached by WALKING a publisher feed's remoteItems —
   * i.e. the `feedGuid` the caller resolved from names the publisher, not the
   * feed the track actually lives in.
   *
   * The distinction is invisible in the result otherwise: both branches return
   * a value block, a title and an image, so a caller recording "the track's
   * parent feed" from its own `feedGuid` silently records the wrong one. That
   * matters because a track favorite publishes that guid to a shared list other
   * apps read, and `/episodes/byguid` can never resolve a publisher guid — the
   * entry is a placeholder forever, on every device.
   */
  viaPublisher?: boolean;
  /** The `<podcast:guid>` of the album feed the item was actually found in.
   *  Only set on the publisher walk, and only when that feed declares one —
   *  a direct hit needs no override, and an album feed with no guid has no
   *  correct answer to offer. */
  albumFeedGuid?: string;
}

/**
 * The item's own value block, else the album's channel-level one, out of an
 * album feed's XML we already hold.
 *
 * **The channel fallback is the half that matters.** Most music feeds declare
 * `<podcast:value>` once, on the channel, and let every track inherit it — so a
 * reader that only looks inside `<item>` finds nothing on the majority of real
 * albums and reports a track as unpayable while its splits sit one level up.
 *
 * Split out because two callers need exactly this and only one of them may have
 * the publisher walk below it: see `resolveItemValueFromRss`.
 */
function directHit(xml: string, itemGuid: string): ResolvedRemoteItem | null {
  const direct = findItemByGuid(xml, itemGuid);
  if (!direct) return null;
  const itemValue = extractValueBlock(direct.itemXml);
  if (itemValue) return { value: itemValue, title: direct.title, image: direct.image };
  const channelValue = extractValueBlock(channelScope(xml));
  if (channelValue) return { value: channelValue, title: direct.title, image: direct.image };
  return null;
}

/**
 * The value block for one item of a feed we ALREADY know is that item's parent.
 *
 * **Deliberately has no publisher walk, and that is the whole reason it is a
 * separate export.** `resolveRemoteItemFromRss` falls through to fetching up to
 * `MAX_ALBUM_FEEDS` album feeds when the URL turns out to name a publisher, and
 * its own comment says why that is capped: the caller's list is feed-supplied,
 * so nested, the two fan-outs MULTIPLY. `/api/playlist` calls this once per
 * unvalued track on a page of up to 100, having resolved each track's real
 * parent feed through Podcast Index first — so there is no publisher to walk,
 * and a walk reachable from there would turn one page into thousands of
 * outbound fetches.
 *
 * Returns null when the feed does not hold the item, or holds it with no value
 * block at any level. Rides the same 5-minute `fetchFeedXml` cache, so N tracks
 * from one album cost one fetch.
 */
export async function resolveItemValueFromRss(
  feedUrl: string,
  itemGuid: string,
): Promise<ValueBlock | null> {
  const xml = await fetchFeedXml(feedUrl);
  if (!xml) return null;
  return directHit(xml, itemGuid)?.value ?? null;
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
  const direct = directHit(xml, itemGuid);
  if (direct) return direct;

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

  // Bounded, not `Promise.all`. Slicing `all` above caps how many albums are
  // SEARCHED; it does not cap how many are fetched at once, and this walk is
  // the inner half of a nested pair — `resolveValueTimeSplits` calls it once
  // per split, so an unbounded inner loop multiplied by an unbounded outer one
  // is 200 x 100 concurrent `readCappedText` reads out of a single request.
  // Ordering is unchanged: `mapLimit` writes results by index, so the
  // first-match-by-index pick below still returns the same album it always did.
  const candidates = await mapLimit(
    albumUrls,
    FEED_FANOUT,
    async (albumUrl): Promise<ResolvedRemoteItem | null> => {
      const albumXml = await fetchFeedXml(albumUrl);
      if (!albumXml) return null;
      const found = findItemByGuid(albumXml, itemGuid);
      if (!found) return null;
      // Read once, here, where the album feed's own XML is in hand — it is the
      // only point in the walk that knows which of N feeds the item came from.
      const albumFeedGuid = channelGuid(albumXml);
      const itemValue = extractValueBlock(found.itemXml);
      if (itemValue) {
        return {
          value: itemValue, title: found.title, image: found.image,
          viaPublisher: true, albumFeedGuid,
        };
      }
      const channelValue = extractValueBlock(channelScope(albumXml));
      if (channelValue) {
        return {
          value: channelValue, title: found.title, image: found.image,
          viaPublisher: true, albumFeedGuid,
        };
      }
      return null;
    },
  );

  return candidates.find((c): c is ResolvedRemoteItem => c !== null) ?? null;
}
