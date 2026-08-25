// Read-only HTTP API. Fixed endpoint shapes, server-capped limits, one shared
// secret. Nothing here writes an event; the only writes are the Podcast Index
// cache fills, which are answers from PI rather than anything a caller supplied.

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Db } from './db.ts';
import {
  bundle, clampLimit, globalNotes, notesByAuthor, notesByIdentifier, notesMentioning,
  profilesFor, repostsBy, zapsReceived,
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

function isHex64(v: unknown): v is string {
  return typeof v === 'string' && HEX64.test(v);
}

/** A guid arrives from feed data and lands in a SQL parameter and a PI URL.
 *  Bound its length and reject control characters; everything else is a
 *  parameterised value and safe by construction. */
function isGuid(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v);
}

export function buildApi(db: Db, cfg: ApiConfig): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url === '/health') return;
    const key = req.headers['x-index-key'];
    if (typeof key !== 'string' || key !== cfg.apiKey) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/health', async () => ({ ok: true }));

  // --- feed bundles --------------------------------------------------------
  //
  // Each returns notes + their whole reply forest + quoted events + author
  // profiles in ONE response. That is the point of the whole service: the
  // client currently pays four serial relay stages for the same thing.

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
    const ids = (q.ids ?? '').split(',').map((s) => s.trim()).filter(isHex64).slice(0, MAX_BATCH * 5);
    return { events: await repostsBy(db, q.pubkey, ids) };
  });

  app.get('/profiles', async (req) => {
    const q = req.query as Record<string, string>;
    const pubkeys = (q.pubkeys ?? '').split(',').map((s) => s.trim()).filter(isHex64).slice(0, 500);
    return { profiles: await profilesFor(db, pubkeys) };
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
      await Promise.all(missing.map(async (g) => {
        const ans = g.startsWith('url:') ? await fetchPodcastByFeedUrl(g.slice(4)) : await fetchPodcastByGuid(g);
        // `null` means we could not ask. Leave the key ABSENT and write nothing.
        if (!ans) return;
        out[g] = 'found' in ans ? ans.found : null;
        await db.query(
          `insert into pi_podcasts (guid, data, miss, fetched_at) values ($1, $2::jsonb, $3, now())
           on conflict (guid) do update set data = excluded.data, miss = excluded.miss, fetched_at = now()`,
          [g, 'found' in ans ? JSON.stringify(ans.found) : null, !('found' in ans)],
        );
      }));
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
      await Promise.all(missing.map(async (r) => {
        const ans = await fetchEpisodeByGuid(r.feedGuid, r.itemGuid);
        if (!ans) return; // could not ask - key stays absent
        out[`${r.feedGuid}:${r.itemGuid}`] = 'found' in ans ? ans.found : null;
        await db.query(
          `insert into pi_episodes (feed_guid, item_guid, data, miss, fetched_at) values ($1, $2, $3::jsonb, $4, now())
           on conflict (feed_guid, item_guid) do update set data = excluded.data, miss = excluded.miss, fetched_at = now()`,
          [r.feedGuid, r.itemGuid, 'found' in ans ? JSON.stringify(ans.found) : null, !('found' in ans)],
        );
      }));
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

function toUntil(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
