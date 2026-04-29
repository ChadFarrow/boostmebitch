// Server-only minimal RSS / Podcasting 2.0 parser. Used by
// /api/feed-by-url to load a feed without hitting Podcast Index — useful
// for local dev when PODCAST_INDEX_KEY isn't set. Hand-rolled regex parsing
// is fragile by design; only fields we actually render are extracted, and
// well-formed feeds with the standard `podcast:` namespace are assumed.

import crypto from 'node:crypto';
import type { Podcast, Episode, ValueBlock, ValueRecipient } from './types';

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function clean(s: string | null | undefined): string | undefined {
  if (s == null) return undefined;
  return decodeEntities(stripCdata(s));
}

function tag(xml: string, name: string): string | null {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

function attr(xml: string, tagName: string, name: string): string | null {
  const re = new RegExp(`<${tagName}\\b[^>]*?\\s${name}="([^"]*)"[^>]*?/?>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

function parseValueBlock(xml: string): ValueBlock | null {
  const block = tag(xml, 'podcast:value');
  if (!block) return null;
  // Header attrs live on the open tag, so re-match against the slice.
  const opener = xml.match(/<podcast:value\b[^>]*>/i)?.[0] ?? '';
  const type = opener.match(/\stype="([^"]*)"/i)?.[1] ?? 'lightning';
  const method = opener.match(/\smethod="([^"]*)"/i)?.[1] ?? 'keysend';
  const suggested = opener.match(/\ssuggested="([^"]*)"/i)?.[1];

  const recipients: ValueRecipient[] = [];
  const recipientRe = /<podcast:valueRecipient\b[^>]*\/?>(?:\s*<\/podcast:valueRecipient>)?/gi;
  for (const match of block.matchAll(recipientRe)) {
    const r = match[0];
    const split = Number(r.match(/\ssplit="([^"]*)"/i)?.[1] ?? '0') || 0;
    if (!split) continue;
    const address = r.match(/\saddress="([^"]*)"/i)?.[1];
    if (!address) continue;
    recipients.push({
      name: r.match(/\sname="([^"]*)"/i)?.[1],
      type: r.match(/\stype="([^"]*)"/i)?.[1] ?? 'node',
      address,
      customKey: r.match(/\scustomKey="([^"]*)"/i)?.[1],
      customValue: r.match(/\scustomValue="([^"]*)"/i)?.[1],
      split,
      fee: /fee="true"/i.test(r) || undefined,
    });
  }
  if (!recipients.length) return null;
  return { type, method, suggested, recipients };
}

// Synthetic numeric ID derived from the feed URL — keeps Podcast.id typed as
// number and stable across reloads of the same URL. Negative space marks it
// as "not a real Podcast Index ID" so it's distinguishable in logs.
function syntheticId(url: string): number {
  const hex = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
  return -Math.abs(parseInt(hex, 16) % 1_000_000_000);
}

function parseDuration(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  // hh:mm:ss or mm:ss
  const parts = trimmed.split(':').map(Number);
  if (parts.some(isNaN)) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return undefined;
}

export async function fetchAndParseRss(url: string): Promise<{ podcast: Podcast; episodes: Episode[] }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': process.env.APP_NAME ?? 'boostmebitch/0.1' },
  });
  if (!res.ok) throw new Error(`RSS fetch failed (${res.status})`);
  const xml = await res.text();

  // Split off <item> blocks; channel metadata lives before the first item.
  const itemBlocks: string[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  for (const m of xml.matchAll(itemRe)) itemBlocks.push(m[1]);
  const firstItemIdx = xml.search(/<item\b/i);
  const channelXml = firstItemIdx >= 0 ? xml.slice(0, firstItemIdx) : xml;

  const id = syntheticId(url);
  const title = clean(tag(channelXml, 'title')) ?? 'Untitled feed';
  const description = clean(tag(channelXml, 'description'));
  const author = clean(tag(channelXml, 'itunes:author'));
  const podcastGuid = clean(tag(channelXml, 'podcast:guid'));
  const link = clean(tag(channelXml, 'link'));
  const image =
    attr(channelXml, 'itunes:image', 'href') ??
    clean(tag(tag(channelXml, 'image') ?? '', 'url')) ??
    undefined;
  const value = parseValueBlock(channelXml);

  const podcast: Podcast = {
    id,
    podcastGuid,
    title,
    author,
    description,
    image,
    url: url || link,
    value,
  };

  const episodes: Episode[] = itemBlocks.map((itemXml, idx) => {
    const eTitle = clean(tag(itemXml, 'title')) ?? `Episode ${idx + 1}`;
    const eDesc = clean(tag(itemXml, 'description'));
    const enclosureUrl = attr(itemXml, 'enclosure', 'url') ?? '';
    const enclosureType = attr(itemXml, 'enclosure', 'type') ?? undefined;
    const guid = clean(tag(itemXml, 'guid'));
    const dateStr = clean(tag(itemXml, 'pubDate'));
    const datePublished = dateStr ? Math.floor(new Date(dateStr).getTime() / 1000) : undefined;
    const duration = parseDuration(clean(tag(itemXml, 'itunes:duration')));
    const eImage = attr(itemXml, 'itunes:image', 'href') ?? undefined;
    const eValue = parseValueBlock(itemXml) ?? value;

    return {
      id: -(idx + 1),
      guid,
      title: eTitle,
      description: eDesc,
      enclosureUrl,
      enclosureType,
      duration,
      datePublished,
      image: eImage,
      feedId: id,
      feedTitle: title,
      feedImage: image,
      podcastGuid,
      value: eValue,
    };
  }).filter((e) => e.enclosureUrl);

  return { podcast, episodes };
}
