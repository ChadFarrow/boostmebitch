// Server-side client for the nostr-index service (services/nostr-index).
//
// SERVER-ONLY. It reads INDEX_API_KEY-equivalent config from the environment,
// and that key must never reach the browser — the only reason the app proxies
// the index at all rather than letting the page call it directly.
//
// Every function here fails SOFT. The index is an accelerator: a caller that
// gets `null` runs the relay or Podcast Index path it would have run anyway,
// so an index that is down, slow or unconfigured costs nothing but the
// speed-up. Nothing in this file may throw its way out to a route.
//
// Failing soft is not the same as failing SILENT, and this file used to be
// both. The service OOMed and stopped itself for three days (#301) with no
// server-side signal at all: `/api/nostr/index` answers 503, which shows up
// only as a status in the access log, and lib/pi-batch.ts calls askIndex
// directly, so that path produced nothing whatsoever. Nobody noticed until
// favorites hydration was measured at ~445 Podcast Index calls per device.
// `warnIndex` below is the whole fix for that, and it is deliberately the
// cheapest possible one.

import { readCappedJson } from './capped-body';

const TIMEOUT_MS = 6_000;

/**
 * Ceiling for one index answer. `AbortSignal.timeout` bounds how LONG a read
 * runs, never how many bytes it returns — the distinction lib/safe-fetch.ts
 * exists for.
 */
const MAX_INDEX_BYTES = 8 * 1024 * 1024;

export function indexConfigured(): boolean {
  return Boolean(process.env.NOSTR_INDEX_URL?.trim() && process.env.NOSTR_INDEX_KEY?.trim());
}

function base(): string {
  return (process.env.NOSTR_INDEX_URL ?? '').trim().replace(/\/$/, '');
}

/** How often one instance may repeat the SAME "index is not answering" line. */
const WARN_EVERY_MS = 60_000;
let lastWarnAt = 0;
let lastWarnWhat = '';

/**
 * Say, at most once a minute per instance, that the index could not be asked.
 *
 * THROTTLED, because `askIndex` runs per request and every caller swallows the
 * null — an unthrottled line turns a dead index into one log entry per
 * visitor, which is how an alert becomes noise nobody reads. Throttled rather
 * than once-per-process, because a box that recovers and dies again has to be
 * able to say so a second time; module state resets on a cold start anyway,
 * which is roughly the granularity we want.
 *
 * `what` must never carry the QUERY STRING. A path here can hold the user's
 * own search text (`/search?q=…`), and writing that to our server logs is the
 * thing lib/nostr/npub-input.ts exists to prevent one layer up — an `nsec`
 * typed into the search box must not reach a log because a fetch failed.
 * Callers pass the path with the query stripped. It never carries the response
 * BODY either: the status is what distinguishes "401, check the key" from
 * "dead box", and the body is attacker-influenced length.
 */
function warnIndex(what: string): void {
  const now = Date.now();
  // A DIFFERENT line always gets through. One timestamp for everything would
  // let a chatty 404 on one route swallow the 401 that explains the outage,
  // and the informative line is exactly the one that arrives second. `what`
  // is route + status, so the distinct set is small and bounded by the route
  // table; only the last one is retained.
  if (what === lastWarnWhat && now - lastWarnAt < WARN_EVERY_MS) return;
  lastWarnAt = now;
  lastWarnWhat = what;
  console.warn(`[nostr-index] ${what} — falling back to the slow path`);
}

/** The path without its query string, for logging. See `warnIndex`. */
function routeOf(path: string): string {
  const q = path.indexOf('?');
  return q === -1 ? path : path.slice(0, q);
}

/**
 * Ask the index. Returns the parsed body, or null for "we could not ask" —
 * unconfigured, unreachable, timed out, refused, or unparseable.
 *
 * `null` NEVER means "the index says no". A route that turns this into a
 * negative answer reintroduces, one layer up, the negative-cache poisoning bug
 * lib/podcast-meta.ts's COULD_NOT_ASK set exists to prevent.
 *
 * Every null but the unconfigured one is logged through `warnIndex`. Absent
 * config is the feature being OFF, not a failure, and must stay silent — it is
 * the normal state of every local checkout.
 */
export async function askIndex<T>(
  path: string,
  init?: { method?: 'GET' | 'POST'; body?: unknown },
): Promise<T | null> {
  if (!indexConfigured()) return null;
  try {
    const res = await fetch(base() + path, {
      method: init?.method ?? 'GET',
      headers: {
        'x-index-key': (process.env.NOSTR_INDEX_KEY ?? '').trim(),
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // The index is our own service and already caps every response; Next's
      // data cache would only add a second, staler copy of a thing whose whole
      // value is freshness. CDN caching happens on the route's own response.
      cache: 'no-store',
    });
    if (!res.ok) {
      warnIndex(`${routeOf(path)} answered ${res.status}`);
      return null;
    }
    // Capped, like every other proxied body in this app.
    //
    // The comment above says the index "already caps every response", and that
    // is true of the service as deployed — but nothing in THIS process enforces
    // it, and `/api/nostr/index` re-serializes whatever comes back to the
    // caller. `NOSTR_INDEX_URL` is an environment variable, so the shape of the
    // thing on the other end is a deployment fact rather than a code one; a
    // misconfigured or replaced host would buffer without limit into the app's
    // lambda. This was the one drain site in the codebase reading a proxied
    // body with a bare `res.json()`.
    //
    // The cap is well above any real answer: the largest is a `/feed/global`
    // bundle, which the service bounds by MAX_LIMIT rows.
    return (await readCappedJson(res, MAX_INDEX_BYTES)) as T;
  } catch (e) {
    // The NAME, not the message. `AbortSignal.timeout` gives TimeoutError, a
    // dead host gives TypeError, and readCappedJson throws here too — over
    // MAX_INDEX_BYTES, or on a body that is not JSON — which gives SyntaxError.
    // The name carries which of those it was; the message buys nothing over it
    // and can carry the resolved URL. "Could not be read" rather than "did not
    // answer" for the same reason: the last two of those did get an answer.
    warnIndex(`${routeOf(path)} could not be read (${e instanceof Error ? e.name : 'unknown error'})`);
    return null;
  }
}
