import { BRAND } from '../brand';
import { COMMUNITY_FEED_ORIGIN } from '../curated-playlists';
import { readCappedJson } from '../capped-body';
import { mapLimit } from '../util';
import { podpingEndpoint, podpingRequestUrl } from './rules';

// SERVER-ONLY. Sends a podping for a community playlist feed each time it goes to
// Podcast Index (lib/community/pi-notify.ts calls it from the same place), so
// every app that reads podpings fetches the new feed, not only Podcast Index
// (Chad, 2026-11-19: "for these playlists that get submitted to PI we also need
// to send a podping so apps know they have been updated").
//
// IT GOES THROUGH CHAD'S msp-podping-service PUSHER, the one musicL-playlist-
// updater uses: `GET <PODPING_ENDPOINT_URL>?url=<feed>&reason=update&medium=musicL`
// with `Authorization: Bearer <PODPING_BEARER_TOKEN>`. The pusher queues, dedups and
// signs with its own Hive account; this app holds no Hive key.
//
// A PODPING IS PUBLIC AND PERMANENT (it is written to the Hive blockchain), so it is
// OFF unless `podpingEndpoint` (lib/community/rules.ts, pinned by check:community)
// says yes: `COMMUNITY_PI_NOTIFY=on`, both variables set, an https endpoint, the real
// feed origin, and Vercel production or the `beta` branch. A test's endpoint may be a
// loopback stub and nothing else.
//
// THE TOKEN IS READ HERE AND NOWHERE ELSE, and it is never logged, never put in a URL
// and never sent anywhere a redirect could take it (`redirect: 'error'`). A log line
// carries the feed URL (public) and the pusher's one-word answer, nothing from the
// request headers.
//
// The publisher feed (`/feeds/publishers/<npub>.xml`) gets no podping for now.
//
// It never throws. The caller runs it inside `after()`, so a response never waits for it.

/** At most this many podpings are in flight at once (a ban can delete many feeds). */
const PODPING_FANOUT = 4;

/** The pusher to send to, or null when this server must not send. */
export function podpingTarget(): string | null {
  return podpingEndpoint({
    notify: process.env.COMMUNITY_PI_NOTIFY,
    endpoint: process.env.PODPING_ENDPOINT_URL,
    hasToken: !!process.env.PODPING_BEARER_TOKEN,
    vercelEnv: process.env.VERCEL_ENV,
    gitRef: process.env.VERCEL_GIT_COMMIT_REF,
    feedOrigin: COMMUNITY_FEED_ORIGIN,
  });
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The pusher's `{ message }` (a short word like "enqueued"), or null. */
async function pusherMessage(r: Response): Promise<string | null> {
  const body = await readCappedJson(r, 16 * 1024).catch(() => null);
  const m = body && typeof body === 'object' ? (body as Record<string, unknown>).message : null;
  return typeof m === 'string' ? m.slice(0, 80) : null;
}

async function podpingOne(endpoint: string, feedUrl: string): Promise<void> {
  const token = process.env.PODPING_BEARER_TOKEN;
  const url = podpingRequestUrl(endpoint, feedUrl);
  if (!token || !url) return;
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': BRAND.userAgent },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    const message = await pusherMessage(r);
    // "enqueued" and "duplicate" are both success: the pusher dedups a feed it already has.
    if (r.ok) console.log('[community-podping]', message ?? 'sent', feedUrl);
    // 401: the token is wrong. 4xx otherwise: the pusher refused the request.
    else console.warn('[community-podping] pusher answered', r.status, message ?? '', feedUrl);
  } catch (e) {
    console.warn('[community-podping] failed:', why(e), feedUrl);
  }
}

/** Send one podping per feed, `PODPING_FANOUT` at a time. Never throws. */
export async function sendPodpings(endpoint: string, feedUrls: string[]): Promise<void> {
  await mapLimit(feedUrls, PODPING_FANOUT, (u) => podpingOne(endpoint, u)).then(() => {}, () => {});
}
