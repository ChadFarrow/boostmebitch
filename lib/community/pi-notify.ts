import { after } from 'next/server';
import { authHeaders } from '../pi';
import { COMMUNITY_FEED_ORIGIN } from '../curated-playlists';
import { readCappedJson } from '../capped-body';
import { mapLimit } from '../util';
import { piNotifyBase } from './rules';

// SERVER-ONLY. Sends a community playlist feed to Podcast Index, so people can
// find it there (Chad, 2026-11-19: "they get submitted to the podcast index so
// that people can search for them from there"; test playlists too).
//
// A SUBMISSION IS PUBLIC AND PERMANENT: Podcast Index has no delete. So it is
// OFF unless `piNotifyBase` (lib/community/rules.ts, pinned by check:community)
// says yes: `COMMUNITY_PI_NOTIFY=on`, the real feed origin, and Vercel production
// or the `beta` branch. A test's `PI_NOTIFY_API` may name only a loopback stub.
//
// - `publish` (a create or an edit): `add/byfeedurl`, then `hub/pubnotify`.
//   The add is idempotent (PI answers the existing feedId), so every SAVE asks
//   again: a refused first add is retried, and a playlist made before the
//   switch went on is submitted by its next SAVE. Nothing older is sent unasked.
// - `gone` (a delete): `hub/pubnotify` only, so PI reads the 410 sooner. It
//   cannot remove the feed.
//
// It never throws, and a response never waits for it (`after()`). The result is
// logged with the `[community-pi]` prefix: that log line is how the first real
// submission shows whether the key has PI's write permission.

export type PiNotifyKind = 'publish' | 'gone';

/** At most this many feeds are being sent at once (a ban can delete many). */
const PI_NOTIFY_FANOUT = 4;

function piBase(): string | null {
  return piNotifyBase({
    notify: process.env.COMMUNITY_PI_NOTIFY,
    override: process.env.PI_NOTIFY_API,
    vercelEnv: process.env.VERCEL_ENV,
    gitRef: process.env.VERCEL_GIT_COMMIT_REF,
    feedOrigin: COMMUNITY_FEED_ORIGIN,
  });
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** PI's `{ status, feedId, existed, description }`, or null when the body is not that. */
async function piAnswer(r: Response): Promise<Record<string, unknown> | null> {
  const body = await readCappedJson(r, 16 * 1024).catch(() => null);
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
}

async function notifyOne(base: string, feedUrl: string, kind: PiNotifyKind): Promise<void> {
  const q = encodeURIComponent(feedUrl);
  if (kind === 'publish') {
    try {
      const r = await fetch(`${base}/add/byfeedurl?url=${q}`, {
        headers: authHeaders(), cache: 'no-store', signal: AbortSignal.timeout(8_000),
      });
      const a = await piAnswer(r);
      // PI says `status: "true"` as a STRING; a 200 with "false" is a refusal too.
      if (r.ok && a?.status === 'true') {
        console.log('[community-pi] add/byfeedurl: feed', a.feedId,
          a.existed === 'true' ? 'was already in the index:' : 'added:', feedUrl);
      } else {
        // 401: the key lacks PI's write permission (or is wrong). Still ping below.
        console.warn('[community-pi] add/byfeedurl refused:', r.status,
          String(a?.description ?? '').slice(0, 200), feedUrl);
      }
    } catch (e) {
      console.warn('[community-pi] add/byfeedurl failed:', why(e), feedUrl);
    }
  }
  try {
    const p = await fetch(`${base}/hub/pubnotify?url=${q}`, {
      headers: authHeaders(), cache: 'no-store', signal: AbortSignal.timeout(8_000),
    });
    if (!p.ok) console.warn('[community-pi] hub/pubnotify answered', p.status, feedUrl);
    await p.body?.cancel().catch(() => {});
  } catch (e) {
    console.warn('[community-pi] hub/pubnotify failed:', why(e), feedUrl);
  }
}

/**
 * Send one feed, or several, after the response is sent (`after()` keeps the
 * serverless function alive for it), `PI_NOTIFY_FANOUT` at a time. Never throws;
 * outside a request scope it falls back to fire-and-forget.
 */
export function notifyPodcastIndexAfter(feedUrls: string | string[], kind: PiNotifyKind): void {
  const base = piBase();
  if (!base) return;
  const urls = Array.isArray(feedUrls) ? feedUrls : [feedUrls];
  if (urls.length === 0) return;
  const run = () => mapLimit(urls, PI_NOTIFY_FANOUT, (u) => notifyOne(base, u, kind)).then(() => {}, () => {});
  try {
    after(run);
  } catch {
    void run();
  }
}
