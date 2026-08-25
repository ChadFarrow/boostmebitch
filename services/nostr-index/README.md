# nostr-index

A read cache for the Nostr and Podcast Index data `boostmebitch` renders. Runs
on Railway; the web app stays on Vercel.

**Everything in here is rebuildable. Relays remain the source of truth.** Drop
the database and nothing is lost but speed. No code anywhere may publish,
delete, or decide anything on the strength of a row in this service.

## Why it exists

The app reads every Nostr surface in the browser, against relays, on every page
load. One feed load is four serial relay stages — notes, then the reply tree one
query per depth, then profiles in three passes — and nothing paints until all of
it resolves. Favorites hydration is a separate problem: ~445 Podcast Index calls
per device, drained six at a time because that is what a browser's connection
pool allows.

This service holds relay subscriptions open continuously, stores what it sees,
and answers a feed in **one** request with the notes, their whole reply forest,
quoted events and author profiles together.

It cannot run on Vercel. A serverless function has no persistent process to hold
WebSockets open in, and a cron poller would be staler and noisier than what it
replaced.

## What it will not index

Enforced in `src/ingest.ts` (`FORBIDDEN_KINDS`), not only in the subscription
filters — a filter is a request, and a relay may send whatever it likes.

| Kind | Why never |
|---|---|
| 10333 favorites | Read-merge-republish with no partial update. A stale read satisfies the removal test in `mergeFavoritesList` and deletes entries another app wrote, with no undo. |
| 10000 mutes | The private half is NIP-04 ciphertext. |
| 3 follows | A blind republish wipes a follow list. |
| 30078 | Encrypted wallet and settings backups. |
| 4 / 1059 | Direct messages. |
| 10002 | Relay lists belong to the outbox model, not to a cache. |

The favorites speed-up comes entirely from the Podcast Index tables. The
kind:10333 read itself keeps coming from relays, always.

## Running it

```bash
npm install
DATABASE_URL=postgres://... INDEX_API_KEY=... npm start
```

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres. Use Railway's private network URL. |
| `INDEX_API_KEY` | yes | Shared secret every read request must carry. |
| `PORT` | no | Default 8080. |
| `INDEX_ROLE` | no | `all` (default), `api`, or `indexer` — split into two services later without a code change. |
| `INDEX_RELAYS` | no | Comma-separated. Defaults to the app's five. |
| `INDEX_PROFILE_RELAYS` | no | Defaults to the app's three profile outboxes. |
| `INDEX_BACKFILL_DAYS` | no | How far the first history sweep walks. Default 180. |
| `INDEX_RESUBSCRIBE_MS` | no | How often tracked subscriptions are reconsidered. Default 60000. |
| `PODCAST_INDEX_KEY` / `_SECRET` | no | Absent means the `pi_*` tables are only filled on demand, never warmed ahead. |
| `INDEX_PI_TTL_HOURS` | no | How stale a `pi_*` row may be. Default 168. |

Migrations run automatically on boot; `npm run migrate` runs them alone.

## Verifying

```bash
npm run typecheck
npm run verify:ingest                       # no database needed
DATABASE_URL=postgres://... npm run verify   # all three
```

- **`verify/check-ingest.mjs`** pins `src/ingest.ts`. Every vector is a recorded
  call, and the replay runs the whole list against a `naive()` control as well as
  against the shipping module — a vector that does not discriminate fails the
  run rather than sitting green. Exemptions are per-vector (`alsoNaive: true`)
  and carry a reason.
- **`verify/check-api.mjs`** seeds signed events through the real ingest path and
  asks the real API for them: bundle shapes, tombstone exclusion on *every*
  endpoint, and the three-state Podcast Index answer.
- **`verify/check-indexer.mjs`** runs the indexer against a scripted local relay
  (`verify/mock-relay.mjs`) — backfill paging and resume, live delivery, a
  deletion arriving after its note, a deletion from the wrong author, and a
  relay pushing kinds nobody subscribed to.

## The three-state Podcast Index answer

`/pi/podcasts` and `/pi/episodes` return a map, and the difference between two
of its shapes is load-bearing:

| Response | Meaning | Cacheable |
|---|---|---|
| key present, object | PI resolved it | yes |
| key present, `null` | PI answered "not found" | yes — a 404 IS an answer |
| **key absent** | we could not ask | **never** |

Filling an absent key with `null` is the negative-cache poisoning bug the app's
`COULD_NOT_ASK` set exists to prevent, arriving from the server side. It is
pinned by `check-api.mjs`.

## How big does this get

Measured, not estimated. `verify/measure-size.mjs` loads a corpus through the
real ingest path and asks Postgres what it holds:

```bash
DATABASE_URL=postgres://... npm run measure:size
```

At today's corpus — roughly 22,400 boost notes, from `ReedBTC/onlyboosts`'
published measurement of the same network-wide stream:

| Table | Rows | Total |
|---|---|---|
| `event_tags` | 240,600 | 107 MB |
| `events` | 34,100 | 59 MB |
| `pi_episodes` | 6,700 | 6 MB |
| `pi_podcasts` | 1,300 | 3 MB |
| `pi_queue` | transient | 3 MB |
| `profiles` | 2,000 | 2 MB |
| **Database** | | **~188 MB** |

Per event, all-in: a boost note costs about **5.6 KB** (9 indexable tags at
~445 bytes per `event_tags` row, plus ~1.6 KB of event), a zap receipt about
2.3 KB, a repost about 1.4 KB.

**`event_tags` is 57% of the total and most of that is its index**, because an
event id is a 64-character `TEXT` that appears in the events primary key, the
`event_tags` primary key and the lookup index. Storing ids as `bytea` would
roughly halve it. Not worth doing at this size; it is the lever if it ever is.

Growth is about **1,000 boost notes a month** (21,956 over ~21.5 months in the
measurement above), so with replies and zaps in proportion, **under 10 MB a
month**. Ten times today's corpus is under 2 GB — everything here is
row-proportional, so it scales linearly.

`pi_queue` drains once `PODCAST_INDEX_KEY` is set; it only accumulates while
the warm-fill is disabled.

