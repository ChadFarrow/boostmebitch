// Read queries. Every one has a fixed shape and a server-enforced cap.
//
// The client never passes a filter, a relay URL, or a raw SQL fragment. That is
// not only an abuse rule — an open filter surface onto Postgres is a way to ask
// for an unbounded scan, and this database sits behind a $5 box.

import type { Db } from './db.ts';

export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 100;

// Mirrors the client's own caps in lib/nostr/discover.ts, so a bundle can never
// describe a deeper or wider thread than the client would have built itself.
export const MAX_THREAD_DEPTH = 6;
export const MAX_REPLIES_PER_THREAD = 200;

export interface StoredEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
  sig: string;
}

export interface FeedBundle {
  notes: StoredEvent[];
  replies: StoredEvent[];
  quoted: StoredEvent[];
  profiles: StoredEvent[];
  indexedThrough: number;
}

export function clampLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

const SELECT_EVENT = `id, pubkey, kind, created_at, content, tags, sig`;

/** Top-level notes carrying a NIP-73 podcast reference — the global feed. */
export async function globalNotes(db: Db, limit: number, until?: number): Promise<StoredEvent[]> {
  const { rows } = await db.query<StoredEvent>(
    `select ${SELECT_EVENT} from events e
       where e.kind = 1 and e.deleted_at is null
         and ($2::bigint is null or e.created_at < $2)
         and exists (select 1 from event_tags t
                       where t.event_id = e.id and t.name = 'k'
                         and t.value in ('podcast:guid', 'podcast:item:guid'))
       order by e.created_at desc
       limit $1`,
    [limit, until ?? null],
  );
  return rows;
}

/**
 * NIP-53 live activities, newest version per address, within a time window.
 *
 * kind:30311 is ADDRESSABLE, so `(pubkey, d)` names one broadcast and every
 * event at that address is a version of it. `events` is keyed by `id` with
 * `on conflict do nothing`, so the versions accumulate and the dedupe has to
 * happen here — `distinct on` over the address, newest `created_at` first,
 * which is the same rule `parseNostrLiveStream` applies client-side.
 *
 * `sinceSecs` filters on `created_at`, i.e. when the streamer last UPDATED the
 * event. A broadcast whose client stopped updating it hours ago is over,
 * whatever its `status` tag still says; the client applies its own
 * `LIVE_FRESH_SECS` on top and reads the status itself.
 *
 * The `d` tag can be absent, in which case the event id stands in for it —
 * matching the client, where `?? e.id` does the same. Coalescing to a constant
 * instead would collapse every d-less stream from one pubkey into one row.
 *
 * The `d` lookup is a LATERAL taking the lowest `pos`, not `pos = 0`.
 * `event_tags.pos` is the tag's index in the event's own `tags` array, not a
 * rank among `d` tags — a `d` sitting behind a `title` or a `status` is
 * ordinary, and `pos = 0` would find no `d` at all for it, silently falling
 * back to the event id. Every version of that broadcast would then read as a
 * separate address and none would ever be deduped, so an ended stream would
 * sit in the list beside its own live replacement.
 */
export async function liveStreams(db: Db, limit: number, sinceSecs: number): Promise<StoredEvent[]> {
  const { rows } = await db.query<StoredEvent>(
    `select ${SELECT_EVENT} from (
       select distinct on (e.pubkey, coalesce(d.value, e.id))
              e.id, e.pubkey, e.kind, e.created_at, e.content, e.tags, e.sig
         from events e
         left join lateral (
           select t.value from event_tags t
            where t.event_id = e.id and t.name = 'd'
            order by t.pos limit 1
         ) d on true
        where e.kind = 30311 and e.deleted_at is null and e.created_at >= $2
        order by e.pubkey, coalesce(d.value, e.id), e.created_at desc
     ) e
     order by e.created_at desc
     limit $1`,
    [limit, sinceSecs],
  );
  return rows;
}

/** Notes referencing one identifier, e.g. `podcast:guid:<uuid>`. */
export async function notesByIdentifier(db: Db, identifier: string, limit: number, until?: number): Promise<StoredEvent[]> {
  const { rows } = await db.query<StoredEvent>(
    `select ${SELECT_EVENT} from events e
       where e.kind = 1 and e.deleted_at is null
         and ($3::bigint is null or e.created_at < $3)
         and exists (select 1 from event_tags t
                       where t.event_id = e.id and t.name = 'i' and t.value = $2)
       order by e.created_at desc
       limit $1`,
    [limit, identifier, until ?? null],
  );
  return rows;
}

export async function notesByAuthor(db: Db, pubkey: string, limit: number, until?: number): Promise<StoredEvent[]> {
  const { rows } = await db.query<StoredEvent>(
    `select ${SELECT_EVENT} from events e
       where e.kind = 1 and e.pubkey = $2 and e.deleted_at is null
         and ($3::bigint is null or e.created_at < $3)
       order by e.created_at desc
       limit $1`,
    [limit, pubkey, until ?? null],
  );
  return rows;
}

/** Notes that p-tag a pubkey AND carry a podcast reference — "boosts received". */
export async function notesMentioning(db: Db, pubkey: string, limit: number, until?: number): Promise<StoredEvent[]> {
  const { rows } = await db.query<StoredEvent>(
    `select ${SELECT_EVENT} from events e
       where e.kind = 1 and e.deleted_at is null and e.pubkey <> $2
         and ($3::bigint is null or e.created_at < $3)
         and exists (select 1 from event_tags t
                       where t.event_id = e.id and t.name = 'p' and t.value = $2)
         and exists (select 1 from event_tags t
                       where t.event_id = e.id
                         and ((t.name = 'k' and t.value in ('podcast:guid', 'podcast:item:guid'))
                           or (t.name = 't' and t.value in ('boostagram', 'value4value'))))
       order by e.created_at desc
       limit $1`,
    [limit, pubkey, until ?? null],
  );
  return rows;
}

export async function zapsReceived(db: Db, pubkey: string, limit: number): Promise<StoredEvent[]> {
  const { rows } = await db.query<StoredEvent>(
    `select ${SELECT_EVENT} from events e
       where e.kind = 9735 and e.deleted_at is null
         and exists (select 1 from event_tags t
                       where t.event_id = e.id and t.name = 'p' and t.value = $2)
       order by e.created_at desc
       limit $1`,
    [limit, pubkey],
  );
  return rows;
}

/** kind:6 reposts by one pubkey over a given set of note ids — what
 *  `useViewerReposts` asks relays for, so a viewer isn't offered a repost
 *  button for something they already reposted. */
export async function repostsBy(db: Db, pubkey: string, ids: string[]): Promise<StoredEvent[]> {
  if (!ids.length) return [];
  const { rows } = await db.query<StoredEvent>(
    `select distinct ${SELECT_EVENT} from events e
       where e.kind = 6 and e.pubkey = $1 and e.deleted_at is null
         and exists (select 1 from event_tags t
                       where t.event_id = e.id and t.name = 'e' and t.value = any($2::text[]))`,
    [pubkey, ids],
  );
  return rows;
}

/**
 * The whole reply forest under a set of roots, in one recursive walk.
 *
 * This is the stage that costs the client the most: it currently issues one
 * relay query PER BFS DEPTH, serially, each with an 8-second ceiling, before
 * profile resolution is even allowed to start.
 */
export async function replyForest(db: Db, rootIds: string[]): Promise<StoredEvent[]> {
  if (!rootIds.length) return [];
  const { rows } = await db.query<StoredEvent>(
    `with recursive tree as (
       select e.id, 0 as depth
         from events e where e.id = any($1::text[])
       union
       select child.id, tree.depth + 1
         from tree
         join event_tags t on t.name = 'e' and t.value = tree.id
         join events child on child.id = t.event_id
        where child.kind = 1 and child.deleted_at is null and tree.depth < $2
     )
     select ${SELECT_EVENT} from events e
       where e.id in (select id from tree)
         and e.id <> all($1::text[])
         and e.deleted_at is null
       order by e.created_at asc
       limit $3`,
    [rootIds, MAX_THREAD_DEPTH, MAX_REPLIES_PER_THREAD * Math.max(1, rootIds.length)],
  );
  return rows;
}

/** Events quoted by `q` tag or by a marked `mention` e-tag. */
export async function quotedEvents(db: Db, sourceIds: string[]): Promise<StoredEvent[]> {
  if (!sourceIds.length) return [];
  const { rows } = await db.query<StoredEvent>(
    `select distinct ${SELECT_EVENT} from events e
       where e.deleted_at is null
         and e.id in (
           select t.value from event_tags t
             where t.event_id = any($1::text[]) and t.name in ('q', 'e')
         )
         and e.id <> all($1::text[])
       limit 200`,
    [sourceIds],
  );
  return rows;
}

/** Profiles as SIGNED kind:0 events, not as parsed metadata.
 *
 *  Returning the event rather than a struct is what lets the client verify the
 *  signature itself, and what stops this index becoming a second, lossier
 *  definition of a profile — the app's own `fetchRawProfile` rule. */
export async function profilesFor(db: Db, pubkeys: string[]): Promise<StoredEvent[]> {
  if (!pubkeys.length) return [];
  const { rows } = await db.query<StoredEvent>(
    `select p.event_id as id, p.pubkey, 0 as kind, p.created_at,
            p.content::text as content, p.tags, p.sig
       from profiles p where p.pubkey = any($1::text[])`,
    [pubkeys],
  );
  return rows;
}

/** Everything a feed surface needs, in one round trip. */
export async function bundle(db: Db, notes: StoredEvent[], indexedThrough: number): Promise<FeedBundle> {
  if (!notes.length) return { notes: [], replies: [], quoted: [], profiles: [], indexedThrough };
  const ids = notes.map((n) => n.id);
  const replies = await replyForest(db, ids);
  const all = [...notes, ...replies];
  const [quoted, profiles] = await Promise.all([
    quotedEvents(db, all.map((e) => e.id)),
    profilesFor(db, Array.from(new Set(all.map((e) => e.pubkey)))),
  ]);
  // A quoted event's author needs a profile too, but a second profile query per
  // bundle is not worth a round trip — the client falls back to its own
  // localStorage cache and then to relays for anyone missing here.
  return { notes, replies, quoted, profiles, indexedThrough };
}
