// Server-side client for the podping viewer's live list
// (ChadFarrow/msp-podping-service, `viewer/`, `GET /api/live`).
//
// SERVER-ONLY by convention: it reads `PODPING_VIEWER_URL` from the
// environment and is imported by `app/api/live-shows` alone.
//
// WHY IT EXISTS. Podcast Index's `/episodes/live` is the only other global list
// of live items, and it misses shows that are on air — measured 2026-09-14
// returning no feed at all with three podping shows broadcasting. A publisher
// that goes live sends a `pp_<medium>_live` podping to Hive, and the viewer
// stores the whole Hive podping firehose, so its answer is the list of feeds
// that SAID they went live in the last day and have not said `liveEnd` since.
//
// AN ACCELERATOR, NEVER AN AUTHORITY. Every function here fails soft to `null`
// ("no answer"), never to `[]` ("nobody is live"), and never throws into the
// route. A podping is the publisher's claim, not proof: every feed it names is
// still read from its own RSS and merged by `mergeLiveOverPi`, so a stale or
// forged podping costs one feed read, never a wrong row.

import { readCappedJson } from './capped-body';

const TIMEOUT_MS = 4_000;

/** The viewer caps the list at 200 rows; this is generous for that. */
const MAX_BYTES = 512 * 1024;

export interface PodpingLiveFeed {
  /** Podcast Index feed id, from the viewer's enrichment. */
  feedId: number;
  /** The feed URL the publisher pinged. */
  url: string;
  /** unix ms, when the viewer recorded the `live` podping. */
  at: number;
}

export function podpingConfigured(): boolean {
  return Boolean(process.env.PODPING_VIEWER_URL?.trim());
}

/** One line per failure kind per minute, so a dead viewer is visible in logs. */
let lastWarnAt = 0;
let lastWarnWhat = '';
function warn(what: string): void {
  const now = Date.now();
  if (what === lastWarnWhat && now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  lastWarnWhat = what;
  console.warn(`[podping] ${what} — live tab falls back to the other rosters`);
}

/**
 * Feeds the podping firehose says are live, newest podping first — or `null`
 * when the viewer is not configured or did not answer.
 *
 * Rows the viewer has not resolved to a Podcast Index id yet are dropped: the
 * route is keyed on feed ids, and the viewer's enricher fills the id within
 * minutes. Rows with a non-http(s) URL are dropped too — the URL came from a
 * public blockchain, and `safeFetch` re-checks it anyway before any read.
 */
export async function fetchPodpingLiveFeeds(): Promise<PodpingLiveFeed[] | null> {
  const base = (process.env.PODPING_VIEWER_URL ?? '').trim().replace(/\/$/, '');
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/live`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) {
      warn(`/api/live answered ${res.status}`);
      return null;
    }
    const body = (await readCappedJson(res, MAX_BYTES)) as { feeds?: unknown };
    if (!Array.isArray(body?.feeds)) {
      warn('/api/live sent no feeds array');
      return null;
    }
    const out: PodpingLiveFeed[] = [];
    const seen = new Set<number>();
    for (const row of body.feeds as Record<string, unknown>[]) {
      const feedId = Number(row?.piFeedId);
      const url = typeof row?.iri === 'string' ? row.iri : '';
      if (!Number.isInteger(feedId) || feedId <= 0 || seen.has(feedId)) continue;
      if (!/^https?:\/\//i.test(url)) continue;
      const at = Date.parse(typeof row.ts === 'string' ? row.ts : '');
      seen.add(feedId);
      out.push({ feedId, url, at: Number.isFinite(at) ? at : 0 });
    }
    return out;
  } catch (e) {
    warn(`/api/live failed: ${e instanceof Error ? e.name : 'error'}`);
    return null;
  }
}
