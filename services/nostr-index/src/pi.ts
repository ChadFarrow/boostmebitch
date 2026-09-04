// Podcast Index client for the warm-fill worker.
//
// Deliberately a SEPARATE, minimal client rather than a copy of lib/pi.ts. That
// file's job is to build the app's rich `Podcast`/`Episode` objects out of PI
// plus RSS enrichment; this one's job is only to keep pi_podcasts/pi_episodes
// warm so the client's own resolvers find their answer without a network hop.
// The client keeps rendering whatever it already renders — this never becomes a
// second definition of what a Podcast is.

import crypto from 'node:crypto';

// Reads its own three variables rather than importing ./config.ts. That module
// throws when DATABASE_URL or INDEX_API_KEY is missing, which is right for the
// entrypoint and wrong here: asking "is Podcast Index configured?" must not
// require the database to be configured too. It also keeps verify/ able to
// exercise the API with PI deliberately switched off.
const BASE = 'https://api.podcastindex.org/api/1.0';

/** PI signals "not found" with HTTP 400, not 404. Both are answers. */
export const NOT_FOUND_STATUSES = new Set([400, 404]);

export class PiHttpError extends Error {
  // A plain field, not a parameter property: `node --experimental-strip-types`
  // refuses parameter properties, and every module here must load under it so
  // verify/ can exercise the shipping code rather than a copy.
  readonly status: number;
  constructor(status: number) {
    super(`PI ${status}`);
    this.name = 'PiHttpError';
    this.status = status;
  }
}

function piKey(): string { return process.env.PODCAST_INDEX_KEY?.trim() || ''; }
function piSecret(): string { return process.env.PODCAST_INDEX_SECRET?.trim() || ''; }

export function piConfigured(): boolean {
  return Boolean(piKey() && piSecret());
}

function authHeaders(): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const key = piKey();
  const hash = crypto.createHash('sha1').update(key + piSecret() + ts).digest('hex');
  return {
    'X-Auth-Key': key,
    'X-Auth-Date': ts,
    Authorization: hash,
    'User-Agent': process.env.APP_NAME?.trim() || 'boostmebitch-index/0.1',
  };
}

async function pi<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new PiHttpError(res.status);
  return (await res.json()) as T;
}

/**
 * Three-state result, and the three states must stay distinguishable all the
 * way out to the client.
 *
 *   { found: value }  PI resolved it            — cacheable
 *   { miss: true }    PI answered "not found"   — cacheable ("404 IS an answer")
 *   null              we could not ask          — NEVER cacheable
 *
 * Collapsing the third into the second is the poisoning bug the app's
 * COULD_NOT_ASK set exists to prevent: an entry recorded as absent because a
 * rate limiter or a timeout got in the way, then never retried.
 */
export type PiAnswer<T> = { found: T } | { miss: true } | null;

export async function fetchPodcastByGuid(guid: string): Promise<PiAnswer<unknown>> {
  return ask(`/podcasts/byguid?guid=${encodeURIComponent(guid)}`, (d: any) => d?.feed);
}

export async function fetchPodcastByFeedUrl(feedUrl: string): Promise<PiAnswer<unknown>> {
  return ask(`/podcasts/byfeedurl?url=${encodeURIComponent(feedUrl)}`, (d: any) => d?.feed);
}

export async function fetchEpisodeByGuid(feedGuid: string, itemGuid: string): Promise<PiAnswer<unknown>> {
  return ask(
    `/episodes/byguid?guid=${encodeURIComponent(itemGuid)}&podcastguid=${encodeURIComponent(feedGuid)}`,
    (d: any) => d?.episode,
  );
}

async function ask(path: string, pick: (d: any) => unknown): Promise<PiAnswer<unknown>> {
  try {
    const data = await pi<any>(path);
    const value = pick(data);
    // PI returns 200 with an EMPTY OBJECT for a guid it doesn't hold. That is
    // still an answer — and the test has to actually catch it. `{}` is truthy
    // and is not an array, so the two clauses below both passed it through and
    // it was stored as a resolved feed for the whole `piTtlHours` window
    // (default a week). The app's own reader guards this with `feed.id == null`
    // (lib/pi.ts), which is why it never surfaced there; here it meant the
    // cache answered "found" with nothing in it.
    if (!value || (Array.isArray(value) && !value.length)) return { miss: true };
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
      return { miss: true };
    }
    return { found: value };
  } catch (e) {
    if (e instanceof PiHttpError && NOT_FOUND_STATUSES.has(e.status)) return { miss: true };
    // Auth failure, 5xx, timeout, socket error — we could not ask.
    return null;
  }
}
