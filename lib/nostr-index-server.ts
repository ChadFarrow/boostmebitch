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

import { readCappedJson } from './safe-fetch';

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

/**
 * Ask the index. Returns the parsed body, or null for "we could not ask" —
 * unconfigured, unreachable, timed out, refused, or unparseable.
 *
 * `null` NEVER means "the index says no". A route that turns this into a
 * negative answer reintroduces, one layer up, the negative-cache poisoning bug
 * lib/podcast-meta.ts's COULD_NOT_ASK set exists to prevent.
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
    if (!res.ok) return null;
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
  } catch {
    return null;
  }
}
