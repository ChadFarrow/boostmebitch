// Server-side Podcast Index client. Never import from a client component.
import crypto from 'node:crypto';
import type { Podcast, Episode, ValueBlock, ValueRecipient, ValueTimeSplit, SocialInteract, PodrollItem, FundingLink, AlternateEnclosure } from './types';
import { resolveRemoteItemFromRss } from './musicl-resolver';
import { safeFetch } from './safe-fetch';
import { fnvHash } from './util';

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

async function pi<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: authHeaders(),
    // Podcast Index data is fairly cacheable; 60s is sane for search.
    next: { revalidate: 60 },
  });
  if (!res.ok) throw new PiHttpError(res.status, await res.text());
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
    medium: typeof f.medium === 'string' && f.medium.length > 0 ? f.medium : undefined,
    value: normalizeValue(f.value),
    funding: fundingFromPi(f),
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

export async function getPodcastByFeedUrl(feedUrl: string): Promise<Podcast | null> {
  try {
    const data = await pi<any>(`/podcasts/byfeedurl?url=${encodeURIComponent(feedUrl)}`);
    return data.feed ? buildPodcast(data.feed) : null;
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
    link: typeof e.link === 'string' && e.link ? e.link : undefined,
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
    ...transcriptFromPi(e),
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
const RSS_FRESH_MS = 60_000;
const RSS_STALE_MS = 10 * 60_000;
const rssXmlCache = new Map<string, { xml: string; fetchedAt: number }>();

async function fetchFeedXml(rssUrl: string): Promise<string | null> {
  const now = Date.now();
  const hit = rssXmlCache.get(rssUrl);
  if (hit && now - hit.fetchedAt < RSS_FRESH_MS) return hit.xml;

  let xml: string | null = null;
  try {
    const res = await safeFetch(rssUrl, {
      headers: { 'User-Agent': process.env.APP_NAME ?? 'boostmebitch/0.1' },
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) xml = await res.text();
  } catch {
    // fall through to the stale-on-error path
  }

  if (xml != null) {
    rssXmlCache.set(rssUrl, { xml, fetchedAt: now });
    return xml;
  }
  // Fetch failed or returned non-2xx — serve the last good copy if it's still
  // within the hard stale window, otherwise give up.
  if (hit && now - hit.fetchedAt < RSS_STALE_MS) return hit.xml;
  return null;
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
  const xml = await fetchFeedXml(rssUrl);
  if (xml == null) return [];
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
// Safe for dangerouslySetInnerHTML: strips dangerous tags + attributes,
// forces links to open in a new tab, blocks javascript: and data: URIs.

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
      const href = readAttr(attrs, 'href');
      // Block dangerous schemes: javascript: (script), data: (data-URL HTML
      // phishing), vbscript: (legacy). Mirrors the img src check.
      if (!href || /^\s*(javascript|data|vbscript):/i.test(href)) return '<a>';
      return `<a href="${href.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">`;
    }
    if (tag === 'img') {
      const src = readAttr(attrs, 'src');
      if (!src || /^\s*(javascript|data):/i.test(src)) return '';
      const alt = readAttr(attrs, 'alt') ?? '';
      return `<img src="${src.replace(/"/g, '&quot;')}" alt="${alt.replace(/"/g, '&quot;')}" loading="lazy">`;
    }
    return `<${tag}>`;
  });

  out = linkifyNostrRefs(out);
  return out.trim();
}

// Turn bare nostr identifiers in the (already-sanitized) notes HTML into
// njump.me links — npubs/nprofiles/etc. that feeds list as plain text. Runs
// after the allowlist pass so every real <a> is normalized; we split on whole
// anchor blocks and only linkify the text between them, so an npub already
// inside a feed link (e.g. an href) isn't double-wrapped. bech32 is [0-9a-z]
// only, so the href/label need no escaping. njump.me is the app's universal
// nostr link convention (see nostr-note-card.tsx / live-chat.tsx).
const NOSTR_REF_RE =
  /(?<![\w])((?:nostr:)?n(?:pub|profile|event|ote|addr)1[023456789acdefghjklmnpqrstuvwxyz]{20,})/gi;

function linkifyNostrRefs(html: string): string {
  return html
    .split(/(<a\b[^>]*>[\s\S]*?<\/a>)/gi)
    .map((seg, i) =>
      i % 2 === 1
        ? seg // an existing anchor block — leave verbatim
        : seg.replace(NOSTR_REF_RE, (m) => {
            const bech = m.replace(/^nostr:/i, '');
            // Mark person refs (npub/nprofile) so the client can attach a follow
            // button; events (nevent/note/naddr) aren't people, so no marker.
            const person = /^n(pub|profile)1/i.test(bech) ? ` data-npub="${bech}"` : '';
            return `<a href="https://njump.me/${bech}" target="_blank" rel="noopener noreferrer"${person}>${m}</a>`;
          }),
    )
    .join('');
}

interface RssEpisodeEnrichment {
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
}

// Decode the handful of XML entities that show up in short text nodes
// (funding labels). Mirrors the entity pass inside extractText.
function decodeXmlText(raw: string): string {
  return raw
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, '$1')
    .trim()
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
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
  const firstItem = xml.search(/<item\b/i);
  const channelXml = firstItem === -1 ? xml : xml.slice(0, firstItem);
  const feedMedium = extractText(channelXml, 'podcast:medium')?.toLowerCase() || undefined;
  const feedPodroll = parsePodroll(channelXml);
  const feedFunding = parseFunding(channelXml);

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
    // podcast:season number attr takes precedence over text content
    const seasonTagMatch = /<podcast:season\b([^>]*)>/i.exec(inner);
    const seasonStr = (seasonTagMatch ? readAttr(seasonTagMatch[1], 'number') : undefined)
      ?? extractText(inner, 'podcast:season');
    const season = seasonStr != null && seasonStr !== '' ? (Number(seasonStr) || null) : null;
    // podcast:episode is plain text content per spec
    const episodeStr = extractText(inner, 'podcast:episode');
    const episode = episodeStr != null && episodeStr !== '' ? (Number(episodeStr) || null) : null;
    const { transcriptUrl, transcriptType } = parseTranscripts(inner);
    // Item <link> — the episode web page (RSS <link>, not <atom:link>). Full
    // notes often live here when the feed's <description> is abbreviated.
    const link = extractText(inner, 'link') || undefined;
    // <podcast:alternateEnclosure> — alternate renditions (e.g. a video version).
    const alternateEnclosures = parseAlternateEnclosures(inner);
    if (socialInteract || contentEncoded || season != null || episode != null || transcriptUrl || link || alternateEnclosures) {
      episodes.set(guid, { socialInteract, contentEncoded, season, episode, transcriptUrl, transcriptType, link, alternateEnclosures });
    }
  }
  return { episodes, feedMedium, feedPodroll, feedFunding };
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

export async function getFeedFromRss(
  rssUrl: string,
): Promise<{ podcast: Podcast; episodes: Episode[] } | null> {
  const xml = await fetchFeedXml(rssUrl);
  if (xml == null) return null;
  // Guard against a non-feed URL (e.g. an HTML page pasted by mistake): a real
  // RSS feed has a <channel> and/or at least one <item>.
  if (!/<channel\b/i.test(xml) && !/<item\b/i.test(xml)) return null;

  const firstItem = xml.search(/<item\b/i);
  const channelXml = firstItem === -1 ? xml : xml.slice(0, firstItem);

  const feedId = -fnvHash(rssUrl);
  const medium = extractText(channelXml, 'podcast:medium')?.toLowerCase() || undefined;
  const channelRssImage = extractRssImageUrl(channelXml);
  const channelItunesImage = extractItunesImageHref(channelXml);
  const channelImage = channelRssImage ?? channelItunesImage;

  const podcast: Podcast = {
    id: feedId,
    title: extractText(channelXml, 'title') || rssUrl,
    author: extractText(channelXml, 'itunes:author') ?? extractText(channelXml, 'managingEditor'),
    description: extractText(channelXml, 'description'),
    image: channelImage,
    // Keep itunes:image as a second-chance source when it differs from <image>.
    artwork: channelItunesImage && channelItunesImage !== channelImage ? channelItunesImage : undefined,
    url: rssUrl,
    medium,
    value: parseValueBlock(channelXml),
    funding: parseFunding(channelXml),
    podroll: parsePodroll(channelXml),
    isPreview: true,
  };

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
    // podcast:season number attr wins over text; podcast:episode is text.
    const seasonTagMatch = /<podcast:season\b([^>]*)>/i.exec(inner);
    const seasonStr = (seasonTagMatch ? readAttr(seasonTagMatch[1], 'number') : undefined)
      ?? extractText(inner, 'podcast:season');
    const season = seasonStr != null && seasonStr !== '' ? (Number(seasonStr) || null) : null;
    const episodeStr = extractText(inner, 'podcast:episode') ?? extractText(inner, 'itunes:episode');
    const episodeNum = episodeStr != null && episodeStr !== '' ? (Number(episodeStr) || null) : null;
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
    });
    idx++;
  }

  // Music album feeds sort by disc (podcast:season) then track (podcast:episode)
  // ascending; everything else newest-first — same rule as /api/feed.
  const isMusic = medium === 'music';
  episodes.sort((a, b) => {
    if (isMusic) {
      const seasonDiff = (a.season ?? 1) - (b.season ?? 1);
      if (seasonDiff !== 0) return seasonDiff;
      return (a.episode ?? 0) - (b.episode ?? 0);
    }
    return (b.datePublished ?? 0) - (a.datePublished ?? 0);
  });

  return { podcast, episodes };
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

