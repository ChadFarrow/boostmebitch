/**
 * An identifier that changes on every deploy, and on nothing else.
 *
 * It exists for one caller: the service worker's cache names
 * (`app/sw.js/route.ts`). `activate` deletes every `bmb-sw-*` cache whose name
 * is not the current build's, which is how a deploy's stale chunks are dropped
 * exactly and auditably rather than by a size heuristic.
 *
 * `NEXT_PUBLIC_BUILD_ID` is set in `next.config.mjs` at build time, so Next
 * inlines it wherever it is read. The Vercel commit SHA is preferred because it
 * is the same string for every instance of one deploy; the timestamp fallback
 * covers a local `next build`, where "every build is different" is exactly what
 * is wanted.
 *
 * **It must never be a value that changes at RUNTIME.** A per-request id would
 * make every request a different cache name, so the caches would grow without
 * bound and `activate` would delete the set it had just written.
 */
export const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID || 'dev';
