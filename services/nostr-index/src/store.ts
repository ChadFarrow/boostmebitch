// Database writes. Every decision this makes comes from src/ingest.ts; this
// module only does the I/O, so the rules stay testable without a Postgres.

import type { Event } from 'nostr-tools';
import type { Db } from './db.ts';
import { classify, indexableTags, podcastRefs, trackedFrom } from './ingest.ts';

export interface IngestStats {
  stored: number;
  profiles: number;
  deleted: number;
  rejected: number;
  rejectReasons: Record<string, number>;
}

export function emptyStats(): IngestStats {
  return { stored: 0, profiles: 0, deleted: 0, rejected: 0, rejectReasons: {} };
}

/**
 * Store one event and everything derived from it, in ONE transaction.
 *
 * The transaction is not decoration. `events` and `event_tags` are read
 * together by every feed query, so a crash between the two inserts would leave
 * a note that exists but matches no filter — present in the table, invisible
 * to every surface, and indistinguishable from never having been indexed.
 */
export async function ingestEvent(db: Db, event: Event, stats: IngestStats): Promise<void> {
  const action = classify(event);

  if (action.type === 'reject') {
    stats.rejected++;
    stats.rejectReasons[action.reason] = (stats.rejectReasons[action.reason] ?? 0) + 1;
    return;
  }

  if (action.type === 'delete') {
    // A deletion may only delete its OWN author's events. Without the pubkey
    // predicate anyone could tombstone anyone's notes by publishing a kind:5
    // naming them — a signed event, verified, and still not authorisation.
    const res = await db.query(
      `update events set deleted_at = now()
         where id = any($1::text[]) and pubkey = $2 and deleted_at is null`,
      [action.targets, event.pubkey],
    );
    stats.deleted += res.rowCount ?? 0;
    return;
  }

  const client = await db.connect();
  try {
    await client.query('begin');

    if (action.type === 'profile') {
      // Replaceable: keep the newest only. `created_at` decides, never arrival
      // order — relays serve history out of order all the time.
      await client.query(
        // `content_raw` is event.content VERBATIM and `content` is the jsonb
        // projection of it. Both, on purpose, and they are not redundant:
        // jsonb normalises (sorted keys, whitespace, decoded escapes), so
        // content::text is NOT the bytes getEventHash covered, and an event
        // served from it fails verifyEvent on the client — which is what was
        // happening to every profile this service served. The jsonb copy stays
        // because the generated name columns are derived from it.
        `insert into profiles (pubkey, event_id, created_at, content, content_raw, tags, sig, updated_at)
           values ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, now())
         on conflict (pubkey) do update
           set event_id = excluded.event_id,
               created_at = excluded.created_at,
               content = excluded.content,
               content_raw = excluded.content_raw,
               tags = excluded.tags,
               sig = excluded.sig,
               updated_at = now()
         where profiles.created_at < excluded.created_at`,
        [
          event.pubkey,
          event.id,
          event.created_at,
          jsonOrEmpty(event.content),
          event.content,
          JSON.stringify(event.tags),
          event.sig,
        ],
      );
      await client.query('commit');
      stats.profiles++;
      return;
    }

    // An event id is the hash of its own content, so a conflict is the same
    // event arriving from a second relay — never an update.
    const ins = await client.query(
      `insert into events (id, pubkey, kind, created_at, content, tags, sig)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7)
       on conflict (id) do nothing`,
      [event.id, event.pubkey, event.kind, event.created_at, event.content, JSON.stringify(event.tags), event.sig],
    );

    if (ins.rowCount) {
      const tags = indexableTags(event);
      if (tags.length) {
        await client.query(
          `insert into event_tags (event_id, name, value, pos)
             select $1, * from unnest($2::text[], $3::text[], $4::int[])
           on conflict do nothing`,
          [event.id, tags.map((t) => t.name), tags.map((t) => t.value), tags.map((t) => t.pos)],
        );
      }

      const tracked = trackedFrom(event);
      if (tracked.length) {
        // `do update set seen_at = now()`, not `do nothing`.
        //
        // `trackedPubkeys` takes the 5000 most recent rows BY `seen_at`, and
        // with `do nothing` that column was first-seen and never moved — so it
        // ordered by "most recently DISCOVERED", not "most recently active".
        // The 180-day backfill discovers thousands of pubkeys off old notes,
        // each stamped `now()`, which pushed the authors of the notes the live
        // subscription had just seen out of the window; their kind:0
        // subscription was then dropped and never reopened. Refreshing on every
        // sighting is what makes the window mean what its query says it means.
        await client.query(
          `insert into tracked_pubkeys (pubkey, reason)
             select * from unnest($1::text[], $2::text[])
           on conflict (pubkey) do update set seen_at = now()`,
          [tracked.map((t) => t.pubkey), tracked.map((t) => t.reason)],
        );
      }

      if (event.kind === 1) await queuePodcastRefs(client, event);
      stats.stored++;
    }

    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function queuePodcastRefs(client: { query: Db['query'] }, event: Event): Promise<void> {
  const refs = podcastRefs(event);
  if (refs.feedGuids.length) {
    await client.query(
      `insert into pi_queue (key, kind, feed_guid)
         select 'p:' || g, 'podcast', g from unnest($1::text[]) as g
       on conflict (key) do nothing`,
      [refs.feedGuids],
    );
  }
  if (refs.items.length) {
    await client.query(
      `insert into pi_queue (key, kind, feed_guid, item_guid)
         select 'e:' || f || ':' || i, 'episode', f, i
           from unnest($1::text[], $2::text[]) as t(f, i)
       on conflict (key) do nothing`,
      [refs.items.map((i) => i.feedGuid), refs.items.map((i) => i.itemGuid)],
    );
  }
}

/** kind:0 content is a JSON object by convention, but it is a free-text field
 *  and publishers do put junk there. Store `{}` rather than failing the whole
 *  insert — a profile we cannot parse is still a pubkey we have seen. */
function jsonOrEmpty(content: string): string {
  try {
    const v = JSON.parse(content);
    return v && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : '{}';
  } catch {
    return '{}';
  }
}

/**
 * The newest stored kind:1 ids, for the reply watcher's `#e` filter.
 *
 * `created_at`, not `seen_at`: the question is "which notes are new enough
 * that people may still be replying to them", which is about when the note was
 * PUBLISHED, not when this index happened to see it. Ordering by arrival would
 * put a whole backfill page at the top and watch five-month-old notes for
 * replies while ignoring this morning's.
 *
 * Tombstoned notes are excluded — a deleted note's replies are not something to
 * go looking for.
 */
export async function recentNoteIds(db: Db, limit = 2_000): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select id from events
       where kind = 1 and deleted_at is null
       order by created_at desc limit $1`,
    [limit],
  );
  return rows.map((r) => r.id);
}

export async function trackedPubkeys(db: Db, limit = 20_000): Promise<string[]> {
  const { rows } = await db.query<{ pubkey: string }>(
    'select pubkey from tracked_pubkeys order by seen_at desc limit $1',
    [limit],
  );
  return rows.map((r) => r.pubkey);
}

export async function getState(db: Db, key: string) {
  const { rows } = await db.query<{
    backfill_until: number | null;
    backfill_done: boolean;
    last_event_at: number | null;
  }>('select backfill_until, backfill_done, last_event_at from indexer_state where key = $1', [key]);
  return rows[0] ?? null;
}

export async function setState(
  db: Db,
  key: string,
  patch: { relayUrl?: string; backfillUntil?: number; backfillDone?: boolean; lastEventAt?: number; status?: string },
): Promise<void> {
  await db.query(
    `insert into indexer_state (key, relay_url, backfill_until, backfill_done, last_event_at, last_seen_at, status)
       values ($1, $2, $3, coalesce($4, false), $5, now(), $6)
     on conflict (key) do update set
       relay_url      = coalesce(excluded.relay_url, indexer_state.relay_url),
       backfill_until = least(coalesce(excluded.backfill_until, indexer_state.backfill_until),
                              coalesce(indexer_state.backfill_until, excluded.backfill_until)),
       backfill_done  = coalesce($4, indexer_state.backfill_done),
       last_event_at  = greatest(coalesce(excluded.last_event_at, indexer_state.last_event_at),
                                 coalesce(indexer_state.last_event_at, excluded.last_event_at)),
       last_seen_at   = now(),
       status         = coalesce(excluded.status, indexer_state.status)`,
    [key, patch.relayUrl ?? null, patch.backfillUntil ?? null, patch.backfillDone ?? null, patch.lastEventAt ?? null, patch.status ?? null],
  );
}

/** Newest `seen_at` across the index — the freshness signal the API returns as
 *  `indexedThrough`, so a surface can say it is behind rather than silently
 *  showing fewer notes. */
export async function indexedThrough(db: Db): Promise<number> {
  const { rows } = await db.query<{ t: string | null }>(
    `select extract(epoch from max(seen_at))::text as t from events where deleted_at is null`,
  );
  return rows[0]?.t ? Math.floor(Number(rows[0].t)) : 0;
}
