import { after } from 'next/server';
import { authHeaders } from '../pi';
import { COMMUNITY_FEED_ORIGIN } from '../curated-playlists';

// SERVER-ONLY. Tells Podcast Index about a community feed. SWITCHED OFF: a no-op
// unless all three conditions below hold (spec decision 19: no Podcast Index for
// now). It never throws and the response never waits for it.

const PI = 'https://api.podcastindex.org/api/1.0';

function enabled(): boolean {
  return process.env.COMMUNITY_PI_NOTIFY === 'on'
    && process.env.VERCEL_ENV === 'production'
    && COMMUNITY_FEED_ORIGIN === 'https://www.boostmebuddy.com';
}

/** `new` registers the feed (add/byfeedurl) and pings; `update` only pings (hub/pubnotify). */
export async function notifyPodcastIndex(feedUrl: string, kind: 'new' | 'update'): Promise<void> {
  if (!enabled()) return;
  try {
    const q = encodeURIComponent(feedUrl);
    if (kind === 'new') {
      // If the key may not add feeds the call is refused: log it and still ping.
      const r = await fetch(`${PI}/add/byfeedurl?url=${q}`, {
        headers: authHeaders(), cache: 'no-store', signal: AbortSignal.timeout(8_000),
      }).catch(() => null);
      if (!r || !r.ok) console.warn('[community-pi] add/byfeedurl refused or failed:', r?.status ?? 'no answer');
      await r?.body?.cancel().catch(() => {});
    }
    const p = await fetch(`${PI}/hub/pubnotify?url=${q}`, {
      headers: authHeaders(), cache: 'no-store', signal: AbortSignal.timeout(8_000),
    });
    await p.body?.cancel().catch(() => {});
  } catch (e) {
    console.warn('[community-pi] notify failed:', e instanceof Error ? e.message : e);
  }
}

/**
 * Run `notifyPodcastIndex` after the response is sent (`after()` keeps the
 * serverless function alive for it). Never throws; outside a request scope it
 * falls back to fire-and-forget.
 */
export function notifyPodcastIndexAfter(feedUrl: string, kind: 'new' | 'update'): void {
  if (!enabled()) return;
  const run = () => notifyPodcastIndex(feedUrl, kind).catch(() => {});
  try {
    after(run);
  } catch {
    void run();
  }
}
