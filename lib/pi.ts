// Server-side Podcast Index client. Never import from a client component.
import crypto from 'node:crypto';
import type { Podcast, Episode, ValueBlock, ValueRecipient } from './types';

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

export async function getEpisodes(feedId: number, max = 25): Promise<Episode[]> {
  const data = await pi<any>(
    `/episodes/byfeedid?id=${feedId}&max=${max}&fulltext`,
  );
  return (data.items ?? []).map((e: any) => ({
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
    value: normalizeValue(e.value),
  }));
}
