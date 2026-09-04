// Read-only HTTP API. Fixed endpoint shapes, server-capped limits, one shared
// secret. Nothing here writes an event; the only writes are the Podcast Index
// cache fills, which are answers from PI rather than anything a caller supplied.

import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Db } from './db.ts';
import {
  bundle, clampLimit, clampSearchLimit, globalNotes, liveStreams, normalizeSearchQuery,
  notesByAuthor, notesByIdentifier, notesMentioning, profilesFor, repostsBy, searchProfiles,
  zapsReceived,
} from './queries.ts';
import { indexedThrough } from './store.ts';
import { fetchEpisodeByGuid, fetchPodcastByFeedUrl, fetchPodcastByGuid, piConfigured } from './pi.ts';

/** Only the config the API actually reads. Narrower than the service Config on
 *  purpose: it keeps the API constructible from a check script without a full
 *  environment, and makes the dependency legible. */
export interface ApiConfig {
  apiKey: string;
  piTtlHours: number;
}

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_BATCH = 100;

/**
 * How many Podcast Index calls the `/pi/*` routes may have in flight.
 *
 * The app enforces the same ceiling on its own side (`PI_FANOUT` in
 * lib/util.ts) and the indexer's warm-fill paces itself at one request a
 * second; these two routes were the gap, firing up to MAX_BATCH — a hundred —
 * at once. PI rate-limits a burst like that. The value is duplicated here
 * rather than imported for the reason every other constant in this service is:
 * it must never import from the app's `lib/`.
 */
const PI_FANOUT = 6;

/**
 * Run `fn` over `items`, at most `limit` at a time, and NEVER reject.
 *
 * Both halves matter. The routes below used `Promise.all`, which starts
 * everything at once AND abandons the whole batch on the first rejection — so
 * one failing `db.query` threw away every Podcast Index answer already
 * collected in `out` and returned 500, having already spent the quota to fetch
 * them. A per-item failure should cost that item and nothing else: its key
 * stays ABSENT, which is this service's established way of saying "could not
 * ask", so the caller retries later rather than caching an absence.
 */
async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        await fn(items[i]!);
      } catch (e) {
        console.error('[api] pi batch item failed:', e instanceof Error ? e.message : e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function isHex64(v: unknown): v is string {
  return typeof v === 'string' && HEX64.test(v);
}

/** A guid arrives from feed data and lands in a SQL parameter and a PI URL.
 *  Bound its length and reject control characters; everything else is a
 *  parameterised value and safe by construction. */
function isGuid(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v);
}

/** What /health reports about the indexer half, when this process runs one.
 *  A function rather than the Indexer itself so `buildApi` stays constructible
 *  from a check script with no relays and no pool. */
export type HealthProbe = () => Promise<Record<string, unknown>>;

// The kind:30311 window served by /feed/live, matching the client's own.
const LIVE_WINDOW_SECS = 7 * 86_400;

// How stale `indexedThrough` may be before /feed/live refuses to answer.
//
// This gate exists for this route and no other. Every other bundle is public
// history: a note from an hour ago is still true, so a slightly behind index is
// simply a slightly shorter feed. A LIVE list is a claim about right now, and a
// stale one says a finished broadcast is on air — worse than saying nothing,
// because the client's relay fallback would have been right. So when the index
// is behind, this answers 503 and the caller falls back to relays, which is the
// same shape every other index failure already takes.
const LIVE_MAX_STALENESS_SECS = 300;

/**
 * Constant-time compare of the presented API key against the configured one.
 *
 * `a !== b` on strings returns at the first differing byte, so how long the
 * comparison takes is a function of how many leading bytes were right. Over a
 * network that signal is buried in jitter, which is the usual reason to shrug —
 * but this service answers from a fixed host on a fixed path, so an attacker
 * can average away the jitter with repetition, and the thing being guessed is a
 * single long-lived shared secret with no rotation story and no second factor.
 * The correct compare costs one hash.
 *
 * Both sides are hashed first so the inputs handed to `timingSafeEqual` are
 * always 32 bytes. That is not ceremony: `timingSafeEqual` THROWS on a length
 * mismatch, so comparing the raw strings would need a length check in front of
 * it — and that check is itself a fast, reliable oracle for the secret's
 * length. Hashing removes the question.
 */
function keyMatches(presented: string, configured: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(configured).digest();
  return timingSafeEqual(a, b);
}

export function buildApi(db: Db, cfg: ApiConfig, probe?: HealthProbe): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Match the PATH, not the raw URL. `req.url` carries the query string, so
    // the exact compare this used to be made `/health?probe=1` an authenticated
    // route, answering 401 to a caller asking the one question this service
    // answers to anybody. Railway's check sends a bare `/health` and was
    // unaffected, which is what kept it invisible — an uptime monitor or a
    // cache-busting probe is the one that would have found it.
    if (req.url === '/health' || req.url.startsWith('/health?')) return;
    const key = req.headers['x-index-key'];
    if (typeof key !== 'string' || !keyMatches(key, cfg.apiKey)) {
      reply.code(401).send({ error: 'unauthorized' });
      // `return reply` is Fastify's documented way for an ASYNC hook to say "I
      // have answered, stop the lifecycle". MEASURED on the pinned Fastify 5:
      // omitting it also stops — the framework checks `reply.sent` before the
      // handler, so the route did not run either way. This is therefore the
      // documented contract rather than a live bug fix, and it is written down
      // as such so nobody re-derives the alarming version. It is still worth
      // saying: `reply.sent` is an inference, and every handler below opens a
      // database query, which is not a thing to leave resting on an inference
      // across a framework upgrade.
      return reply;
    }
    return undefined;
  });

  // The only unauthenticated route, and it used to be a static literal that
  // never touched the database — so it answered `{ok:true}` on a process whose
  // relay sockets had been dead for hours, which is how this service came to
  // sit stalled without anyone noticing.
  //
  // `ok` reports RELAY CONNECTIVITY, never event freshness. Freshness is the
  // wrong test: this corpus is quiet enough that hours can legitimately pass
  // between notes, so a freshness-gated `ok` would cry wolf on an ordinary
  // afternoon. `secondsBehind` is still reported, as data to read rather than
  // a verdict.
  //
  // It answers HTTP 200 in every case ON PURPOSE. Railway's health check reads
  // this route, and a 503 during a relay-side outage would restart-loop the
  // container while the in-process watchdog was already recovering — which is
  // the better recovery, because it keeps the backfill cursor and the seen-set.
  app.get('/health', async () => {
    if (!probe) return { ok: true, role: 'api' };
    try {
      const h = await probe();
      // Both halves are required. A connected relay carrying no subscriptions
      // is the exact state that stalled this service, and a connectivity-only
      // `ok` reports it as healthy — which is the mistake the static
      // `{ok:true}` made, one level less obviously.
      const connected = (h.relaysConnected as number) > 0;
      const subless = (h.relaysWithoutSubscriptions as string[] | undefined)?.length ?? 0;
      return { ok: connected && subless === 0, ...h };
    } catch (e) {
      // The thrown message is LOGGED, never returned. This route is the only
      // unauthenticated one in the service, and the rule `setErrorHandler`
      // states further down applies most sharply here: a Postgres error
      // carries the failing SQL, and the ones this probe produces name the
      // private-network host and port (`connect ECONNREFUSED 10.x.x.x:5432`),
      // the database role in an auth failure, or a relation name. All of that
      // was being handed to any caller who found the hostname.
      console.error('[api] health probe failed:', e instanceof Error ? e.message : e);
      return { ok: false, error: 'health probe failed' };
    }
  });

  // --- feed bundles --------------------------------------------------------
  //
  // Each returns notes + their whole reply forest + quoted events + author
  // profiles in ONE response. That is the point of the whole service: the
  // client currently pays four serial relay stages for the same thing.

  // NIP-53 live activities for the homepage row. Not a bundle: a stream card
  // renders from the event plus its host's profile, and has no reply forest or
  // quoted events to carry.
  app.get('/feed/live', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const through = await indexedThrough(db);
    const behind = Math.floor(Date.now() / 1000) - through;
    if (!through || behind > LIVE_MAX_STALENESS_SECS) {
      return reply.code(503).send({ error: 'index too stale for live', secondsBehind: through ? behind : -1 });
    }
    const streams = await liveStreams(db, clampLimit(q.limit), Math.floor(Date.now() / 1000) - LIVE_WINDOW_SECS);
    // Host profiles come along for the same reason a feed bundle carries them:
    // without one a card renders a bare npub, and fetching them per card is the
    // N+1 this service exists to remove.
    const profiles = await profilesFor(db, Array.from(new Set(streams.map((e) => e.pubkey))));
    return { streams, profiles, indexedThrough: through };
  });

  app.get('/feed/global', async (req) => {
    const q = req.query as Record<string, string>;
    const notes = await globalNotes(db, clampLimit(q.limit), toUntil(q.until));
    return bundle(db, notes, await indexedThrough(db));
  });

  app.get('/feed/podcast/:guid', async (req, reply) => {
    const { guid } = req.params as { guid: string };
    if (!isGuid(guid)) return reply.code(400).send({ error: 'bad guid' });
    const q = req.query as Record<string, string>;
    const notes = await notesByIdentifier(db, `podcast:guid:${guid}`, clampLimit(q.limit), toUntil(q.until));
    return bundle(db, notes, await indexedThrough(db));
  });

  app.get('/feed/episode/:guid', async (req, reply) => {
    const { guid } = req.params as { guid: string };
    if (!isGuid(guid)) return reply.code(400).send({ error: 'bad guid' });
    const q = req.query as Record<string, string>;
    const notes = await notesByIdentifier(db, `podcast:item:guid:${guid}`, clampLimit(q.limit), toUntil(q.until));
    return bundle(db, notes, await indexedThrough(db));
  });

  app.get('/feed/by-author/:pubkey', async (req, reply) => {
    const { pubkey } = req.params as { pubkey: string };
    if (!isHex64(pubkey)) return reply.code(400).send({ error: 'bad pubkey' });
    const q = req.query as Record<string, string>;
    const notes = await notesByAuthor(db, pubkey, clampLimit(q.limit), toUntil(q.until));
    return bundle(db, notes, await indexedThrough(db));
  });

  app.get('/feed/mentioning/:pubkey', async (req, reply) => {
    const { pubkey } = req.params as { pubkey: string };
    if (!isHex64(pubkey)) return reply.code(400).send({ error: 'bad pubkey' });
    const q = req.query as Record<string, string>;
    const notes = await notesMentioning(db, pubkey, clampLimit(q.limit), toUntil(q.until));
    return bundle(db, notes, await indexedThrough(db));
  });

  // --- zaps, reposts, profiles --------------------------------------------

  app.get('/zaps/received/:pubkey', async (req, reply) => {
    const { pubkey } = req.params as { pubkey: string };
    if (!isHex64(pubkey)) return reply.code(400).send({ error: 'bad pubkey' });
    const q = req.query as Record<string, string>;
    const receipts = await zapsReceived(db, pubkey, clampLimit(q.limit));
    // A zap receipt names its zapper in the kind:9734 it wraps, but the
    // receipt's own pubkey is the LNURL server's. Send both sets of profiles
    // and let the client decide which it needs — it already has that logic.
    const authors = receipts.map((r) => r.pubkey);
    const zappers = receipts.flatMap((r) =>
      r.tags.filter((t) => t[0] === 'P' || t[0] === 'p').map((t) => t[1]),
    );
    const wanted = Array.from(new Set([...authors, ...zappers])).filter(isHex64).slice(0, 500);
    const profiles = await profilesFor(db, wanted);
    return { receipts, profiles, indexedThrough: await indexedThrough(db) };
  });

  app.get('/reposts', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (!isHex64(q.pubkey)) return reply.code(400).send({ error: 'bad pubkey' });
    const ids = (firstParam(q.ids) ?? '').split(',').map((s) => s.trim()).filter(isHex64).slice(0, MAX_BATCH * 5);
    return { events: await repostsBy(db, q.pubkey, ids) };
  });

  app.get('/profiles', async (req) => {
    const q = req.query as Record<string, string>;
    const pubkeys = (firstParam(q.pubkeys) ?? '').split(',').map((s) => s.trim()).filter(isHex64).slice(0, 500);
    return { profiles: await profilesFor(db, pubkeys) };
  });

  // Profiles by NAME PREFIX, for the @-mention picker. Signed kind:0 events,
  // same as /profiles.
  //
  // THIS ROUTE MUST NEVER ANSWER 4xx, and that is not a style preference.
  // askIndex (lib/nostr-index-server.ts) returns null for any !res.ok, the
  // proxy cannot tell that from "could not ask" and answers 503, and ask() in
  // index-client.ts latches indexOffForTab = true for the WHOLE TAB on a 503.
  // So a 400 here — on a one-character query, say — would switch the index off
  // for the global feed, every podcast feed, live streams and zaps until the
  // page is reloaded. The other routes get away with 400s because the proxy's
  // regexes reject a bad pubkey or guid before forwarding; a free-text `q` has
  // no such structural guard. Clamp and answer an empty envelope instead.
  //
  // `query` echoes the normalised string back. It does two jobs: it is the
  // positive "I answered" marker that lets the client tell an empty result from
  // no result at all, and it lets a caller discard an out-of-order response
  // without an AbortController.
  app.get('/profiles/search', async (req) => {
    const q = req.query as Record<string, string>;
    const norm = normalizeSearchQuery(q.q);
    if (!norm) return { profiles: [], query: '' };
    return {
      profiles: await searchProfiles(db, norm, clampSearchLimit(q.limit)),
      query: norm.exact,
    };
  });

  // --- Podcast Index batch -------------------------------------------------
  //
  // THE THREE-STATE ANSWER IS THE CONTRACT and must survive to the client:
  //
  //   key present, value object  -> PI resolved it        (cacheable)
  //   key present, value null    -> PI said "not found"   (cacheable)
  //   key ABSENT from the map    -> we could not ask      (NEVER cacheable)
  //
  // Filling in an absent key with null is the negative-cache poisoning bug the
  // app's COULD_NOT_ASK set exists to prevent, arriving from the server side.

  app.post('/pi/podcasts', async (req, reply) => {
    const body = req.body as { guids?: unknown };
    if (!Array.isArray(body?.guids)) return reply.code(400).send({ error: 'guids must be an array' });
    const guids = body.guids.filter(isGuid).slice(0, MAX_BATCH);
    const out: Record<string, unknown> = {};
    if (!guids.length) return out;

    const { rows } = await db.query<{ guid: string; data: unknown; miss: boolean }>(
      `select guid, data, miss from pi_podcasts
         where guid = any($1::text[]) and fetched_at > now() - ($2 || ' hours')::interval`,
      [guids, String(cfg.piTtlHours)],
    );
    for (const r of rows) out[r.guid] = r.miss ? null : r.data;

    const missing = guids.filter((g) => !(g in out));
    if (missing.length && piConfigured()) {
      await eachLimit(missing, PI_FANOUT, async (g) => {
        const ans = g.startsWith('url:') ? await fetchPodcastByFeedUrl(g.slice(4)) : await fetchPodcastByGuid(g);
        // `null` means we could not ask. Leave the key ABSENT and write nothing.
        if (!ans) return;
        out[g] = 'found' in ans ? ans.found : null;
        await db.query(
          `insert into pi_podcasts (guid, data, miss, fetched_at) values ($1, $2::jsonb, $3, now())
           on conflict (guid) do update set data = excluded.data, miss = excluded.miss, fetched_at = now()`,
          [g, 'found' in ans ? JSON.stringify(ans.found) : null, !('found' in ans)],
        );
      });
    }
    return out;
  });

  app.post('/pi/episodes', async (req, reply) => {
    const body = req.body as { refs?: unknown };
    if (!Array.isArray(body?.refs)) return reply.code(400).send({ error: 'refs must be an array' });
    const refs = (body.refs as { feedGuid?: unknown; itemGuid?: unknown }[])
      .filter((r) => isGuid(r?.feedGuid) && isGuid(r?.itemGuid))
      .map((r) => ({ feedGuid: r.feedGuid as string, itemGuid: r.itemGuid as string }))
      .slice(0, MAX_BATCH);
    const out: Record<string, unknown> = {};
    if (!refs.length) return out;

    const { rows } = await db.query<{ feed_guid: string; item_guid: string; data: unknown; miss: boolean }>(
      `select feed_guid, item_guid, data, miss from pi_episodes
         where (feed_guid, item_guid) in (select * from unnest($1::text[], $2::text[]))
           and fetched_at > now() - ($3 || ' hours')::interval`,
      [refs.map((r) => r.feedGuid), refs.map((r) => r.itemGuid), String(cfg.piTtlHours)],
    );
    for (const r of rows) out[`${r.feed_guid}:${r.item_guid}`] = r.miss ? null : r.data;

    const missing = refs.filter((r) => !(`${r.feedGuid}:${r.itemGuid}` in out));
    if (missing.length && piConfigured()) {
      await eachLimit(missing, PI_FANOUT, async (r) => {
        const ans = await fetchEpisodeByGuid(r.feedGuid, r.itemGuid);
        if (!ans) return; // could not ask - key stays absent
        out[`${r.feedGuid}:${r.itemGuid}`] = 'found' in ans ? ans.found : null;
        await db.query(
          `insert into pi_episodes (feed_guid, item_guid, data, miss, fetched_at) values ($1, $2, $3::jsonb, $4, now())
           on conflict (feed_guid, item_guid) do update set data = excluded.data, miss = excluded.miss, fetched_at = now()`,
          [r.feedGuid, r.itemGuid, 'found' in ans ? JSON.stringify(ans.found) : null, !('found' in ans)],
        );
      });
    }
    return out;
  });

  app.setErrorHandler(async (err: unknown, _req, reply) => {
    // Never reflect the thrown message: a Postgres error carries the failing
    // SQL, and a PI error carries an upstream body. Same rule as the app's own
    // withErrorHandling.
    console.error('[api]', err instanceof Error ? err.message : String(err));
    await reply.code(500).send({ error: 'index request failed' });
  });

  return app;
}

/**
 * Largest `until` this service will pass to Postgres.
 *
 * 2^32-1 is the year 2106 — beyond any Nostr `created_at` that will ever be
 * real, and far below the point where JavaScript switches number formatting to
 * exponential notation. That switch is the actual bug this bounds: node-postgres
 * serializes a parameter with `toString()`, so `until=1e21` reached the driver
 * as the string `"1e+21"`, which `$2::bigint` rejects. The route then answered
 * 500, `askIndex` turned that into `null`, the proxy into 503, and
 * `index-client.ts` set `indexOffForTab` — so one crafted URL switched the read
 * index off for that visitor's entire tab.
 */
const MAX_UNTIL = 4_294_967_295;

/**
 * CLAMPS rather than refusing. Every route that takes `until` is one whose 4xx
 * the client reads as "the index is unavailable", so rejecting an absurd value
 * costs the visitor the accelerator; clamping answers with data, from a cursor
 * no real event is newer than.
 */
function toUntil(raw: string | undefined): number | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.floor(n), MAX_UNTIL);
}

/**
 * The first value for a query key, whatever shape Fastify produced.
 *
 * Fastify's default parser is Node's `querystring.parse`, which returns an
 * ARRAY for a repeated key — so `?ids=aa&ids=bb` handed the handlers an array
 * where `as Record<string, string>` promised a string, and `.split` on it threw
 * a TypeError into a 500. The cast is what hid it from the typechecker. Not
 * reachable through the app's proxy, which collapses duplicates via
 * `forwarded.set`, but every holder of INDEX_API_KEY can reach it directly.
 */
function firstParam(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const first = v.find((x) => typeof x === 'string');
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}
