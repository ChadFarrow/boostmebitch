// The musicL RSS document BMB serves for a community playlist. Pure: no I/O.
// Loaded by check:community under plain Node, so it imports only `node:crypto`
// and erased types.
import { createHash } from 'node:crypto';
import type { StoredPlaylist } from './rules';

// XML 1.0 forbids these: C0 controls except tab/LF/CR, U+FFFE/U+FFFF, and lone
// surrogates. One in a listener's title would make the public feed ill-formed.
const XML_FORBIDDEN = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function escapeXml(s: string): string {
  return s
    .replace(XML_FORBIDDEN, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Podcasting 2.0 guid namespace (podcastindex-org/podcast-namespace, `guid`).
const PODCAST_GUID_NAMESPACE = 'ead4c236-bf58-58c6-a2c6-a6b28d128cb6';

/** UUIDv5 of the feed URL minus scheme and trailing slashes. */
export function communityFeedGuid(feedUrl: string): string {
  const name = feedUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
  const ns = Buffer.from(PODCAST_GUID_NAMESPACE.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(name, 'utf8').digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/**
 * `o.podcastGuid` is the guid STORED with the row when it was created
 * (`community_playlists.podcast_guid`), never one recomputed here from
 * `o.feedUrl`: it is the feed's identity for good — favorites, the by-guid
 * lookup and Podcast Index hold it — so a deploy whose feed origin differs from
 * the one the row was made under must not print a second one.
 */
export function buildPlaylistFeedXml(
  p: StoredPlaylist,
  o: { feedUrl: string; coverUrl: string; ownerNpub: string; fallbackDescription: string; podcastGuid: string },
): string {
  const e = escapeXml;
  const description = p.description || o.fallbackDescription;
  const items = p.songs
    .map((s) => `    <podcast:remoteItem feedGuid="${e(s.feedGuid)}" itemGuid="${e(s.itemGuid)}"`
      + (s.feedUrl ? ` feedUrl="${e(s.feedUrl)}"` : '') + ' medium="music"/>')
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${e(p.title)}</title>
    <description>${e(description)}</description>
    <link>${e(o.feedUrl)}</link>
    <language>en</language>
    <lastBuildDate>${new Date(p.updatedAt).toUTCString()}</lastBuildDate>
    <podcast:guid>${e(o.podcastGuid)}</podcast:guid>
    <podcast:medium>musicL</podcast:medium>
    <podcast:txt purpose="npub">${e(o.ownerNpub)}</podcast:txt>
    <itunes:image href="${e(o.coverUrl)}"/>
    <image>
      <url>${e(o.coverUrl)}</url>
      <title>${e(p.title)}</title>
      <link>${e(o.feedUrl)}</link>
    </image>
${items}
  </channel>
</rss>
`;
}
