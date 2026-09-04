# The read index (`services/nostr-index`)

Read before touching anything under `services/nostr-index/`, and before changing
`lib/nostr-index-server.ts`, `lib/nostr/index-client.ts` or `app/api/nostr/index/`.

Core rules live in [`../CLAUDE.md`](../CLAUDE.md); this file holds the reasoning.
The read-path rules it accelerates are in [`nostr.md`](nostr.md) (index section)
and [`feeds.md`](feeds.md) (batch section) — including the one that matters most,
that **this cache stores Podcast Index's RAW record and every reader must
normalize it**.

## It is a separate deployable, and merging does not ship it

A Node service on Railway with its own `package.json`, `tsconfig.json` and
dependencies, because it holds relay WebSockets open continuously and a
serverless function cannot. It is excluded from this repo's `tsconfig.json` and
`eslint.config.mjs`, so **`npm run typecheck` and `npm run lint` do not cover
it** — which is the standing reason it accumulates faults the app would not.

It must never import from `lib/`, and `lib/` never from it: the relay lists and
NIP-73 prefixes are deliberately duplicated. The app reaches it only through
`lib/nostr-index-server.ts`, server-side.

**Merging to `main` deploys the Vercel app and leaves the index running whatever
was uploaded last** — invisible from the diff, and it cost a session. Ship it
with `railway up` from `services/nostr-index`, **then read the build log for the
package name**: it must say `boostmebitch-nostr-index`, never `boostmebitch`. A
`BadRecordMac` upload failure still creates a deployment stuck at INITIALIZING
with no build log — retry. `railway up` ships your MAIN CHECKOUT rather than the
current directory, so it cannot be run from a worktree. → [`ops.md`](ops.md)

## Its checks are its own

`cd services/nostr-index && npm run typecheck && DATABASE_URL=... npm run verify`.
`verify/check-ingest.mjs` follows the same total-replay-against-`naive()` shape as
the repo's `check:*` scripts; `check-api.mjs`, `check-search.mjs` and
`check-indexer.mjs` need a Postgres, and the indexer one drives a scripted local
relay (`verify/mock-relay.mjs`). `verify:ingest` and `verify:yield` run with no
database.

## A `void` on a background loop ends the process

`start()` launches `backfillLoop` and `piLoop` with a bare `void`, and neither
wrapped all of its `db.query` calls — the pi_queue page read, the attempts bump
and the backfill's `getState`/`setState` all sat outside a try. The pool is
`max: 10` with a ten-second connect timeout, so a Postgres restart or a saturated
pool rejects with **no handler anywhere**: Node's default for an unhandled
rejection is to throw, this service installs no `process.on('unhandledRejection')`,
and `pool.on('error')` covers only IDLE clients, never a rejected query. The
process exits and the relay sockets go with it.

Both loops now back off and continue across a database fault, and both `void`
calls carry a `.catch(logErr(...))` as the backstop. **Any new background loop
here needs both halves** — the local guard so a blip is survivable, and the
`.catch` so an escape is loud rather than fatal.

## An empty page is not evidence

`pool.querySync` **resolves with `[]`** when no relay connects. It does not
throw: a failed connection drives `handleClose` into the EOSE path, so the
`catch` around the page read never sees it. The backfill read that empty page as
"the relays have no more history", wrote `backfill_done = true` and logged
`backfill … complete` — on its first iteration, if it happened to start while the
relays were unreachable. That flag is read at the top of the loop on every later
start, so the 180-day sweep never ran again and only a manual
`delete from indexer_state` recovered it.

An empty page now counts only when `connectedRelays().connected` is non-empty. A
NON-empty page is its own evidence, which is why only the empty case is gated.
This is the service's copy of the app's oldest rule, in
[`nostr.md`](nostr.md): **never record an absence you did not reliably observe.**

## `/health` is the only unauthenticated route

Which makes it the one that has to be most careful, in two directions that both
shipped wrong.

It **reflected the raw thrown message** — `connect ECONNREFUSED
<private-ip>:5432`, the database role in an auth failure, a relation name — to
any caller who found the hostname. That is the rule `setErrorHandler` states in
the same file, broken on the route with no key. It is logged now, not returned.

It also runs `max(seen_at)` over `events`, which carries **no index on
`seen_at`**, so every call is a sequential scan of the largest table. There is no
rate limiter in this service at all; only the Vercel proxy has one, and `/health`
does not go through the proxy. That remains open — the fix is an index or a
cached answer, not removing the probe, because a `/health` that never touches the
database is what let this service sit stalled for hours reporting `{ok:true}`.

## Everything a caller can name has to be bounded

- **`until` is CLAMPED, never refused.** node-postgres serializes a parameter
  with `toString()`, and JavaScript switches to exponential notation at 1e21, so
  `?until=1e21` reached the driver as `"1e+21"` and `$2::bigint` rejected it. The
  route answered 500, `askIndex` turned that into `null`, the proxy into 503, and
  `index-client.ts` set `indexOffForTab` — **one crafted URL switched the read
  index off for that visitor's whole tab.** Clamping rather than refusing is
  deliberate: every route taking `until` is one whose 4xx the client reads as
  "the index is unavailable".
- **A repeated query parameter arrives as an ARRAY.** Fastify's default parser is
  Node's `querystring.parse`, so `?ids=aa&ids=bb` gave the handlers an array where
  `as Record<string, string>` promised a string, and `.split` threw a TypeError
  into a 500. The cast is what hid it from the typechecker. `firstParam` narrows
  it. Not reachable through the app's proxy, which collapses duplicates with
  `forwarded.set` — but every holder of `INDEX_API_KEY` can reach it directly.
- **`/pi/*` is a bounded fan-out that never abandons its batch.** Both routes ran
  `Promise.all` over up to `MAX_BATCH` (100) Podcast Index calls: no concurrency
  cap, and a single rejection discarded every answer already collected in `out`
  after the quota had been spent fetching them. `eachLimit` bounds the width at
  `PI_FANOUT` and isolates a per-item failure, leaving that key **absent** — this
  service's established way of saying "could not ask".
- **`INDEX_ROLE` is validated, not cast.** `as 'all' | 'api' | 'indexer'` makes
  any string type-check, and `index.ts` tests the three literals exactly — so
  `API`, or a value pasted with a trailing character, started NEITHER half and the
  process exited 0 once the pool went idle. A deploy that looks clean, serves
  nothing, and reports nothing. Same class as `brandIdFrom`, and the same answer.
- **Podcast Index answers `{}` for a guid it does not hold**, which is truthy and
  not an array, so both clauses of the miss test passed it through and it was
  cached as a resolved feed for `piTtlHours` (default a week). The app's own
  reader guards this with `feed.id == null`, which is why it never surfaced there.

## The forbidden kinds are enforced in code, not in a filter

`ingest.ts` rejects on `FORBIDDEN_KINDS` before any store decision, and
`STORABLE_KINDS` is an allowlist — because **a subscription filter is a request
and a relay may send anything**. It must never hold kind 10333, 10000, 3, 30078,
4 or 1059: those drive destructive writes, and an accelerator is never an
authority. See [`nostr.md`](nostr.md).
