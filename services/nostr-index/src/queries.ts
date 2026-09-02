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
 * The `status` filter keeps this route from shipping a payload almost none of
 * which can render. Measured against real relays: of the newest 200 events in
 * the window, 140 were explicitly `ended`, 39 carried no status at all and 4
 * were empty — and `parseNostrLiveStream` maps every one of those to `ended`,
 * which `shapeLiveStreams` then drops. 204 KB over the wire to render 17 rows.
 *
 * It is deliberately a SUPERSET of the client's rule, never a copy of it. The
 * client also requires a `live` event to have been updated recently, and that
 * test must stay client-side: it is evaluated at render time, while this
 * response sits in a CDN for 15 s, so a server that applied it would be
 * answering a question about a moment that has passed. Filtering here on the
 * one part that cannot change — an explicit `ended`, or no status to be live by
 * — leaves the time-dependent half where it belongs.
 *
 * `status` is not in `event_tags`: `indexableTags` stores single-letter tags
 * only, per NIP-01's indexed-tag rule. `d` is one and `status` is not, so this
 * reads the whole tag array out of the jsonb column instead. The scan is over
 * the window's few hundred rows, not the table.
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
          and exists (select 1 from jsonb_array_elements(e.tags) tag
                       where tag->>0 = 'status' and tag->>1 in ('live', 'planned'))
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
 *  definition of a profile — the app's own `fetchRawProfile` rule.
 *
 *  `content_raw` FIRST, and that is the whole reason the column exists.
 *  `content` is jsonb, so `content::text` comes back with sorted keys and added
 *  whitespace and therefore hashes to a different event id. Serving that made
 *  the client's `verifyAll` drop EVERY profile this service returned — silently,
 *  on every surface, with each one falling back to relays and looking merely
 *  slow. The coalesce is defence in depth rather than a live path: migration
 *  002 empties this table precisely so no row without a raw copy survives, and
 *  `store.ts` is the only writer and always supplies one. */
export async function profilesFor(db: Db, pubkeys: string[]): Promise<StoredEvent[]> {
  if (!pubkeys.length) return [];
  const { rows } = await db.query<StoredEvent>(
    `select p.event_id as id, p.pubkey, 0 as kind, p.created_at,
            coalesce(p.content_raw, p.content::text) as content, p.tags, p.sig
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

// --- Profile name search (the @-mention picker) ------------------------------

/** Default and ceiling for one search. Small on purpose: every row is
 *  signature-verified on the client at ~3ms, so 20 is ~60ms of arithmetic per
 *  keystroke. Same latency reasoning as INDEX_FEED_LIMIT in index-client.ts. */
export const DEFAULT_SEARCH_RESULTS = 10;
export const MAX_SEARCH_RESULTS = 20;
/** Below this we do not ask at all — a one-character prefix matches a large
 *  fraction of the table. */
export const MIN_SEARCH_QUERY = 2;
export const MAX_SEARCH_QUERY = 64;
/** How many rows each branch of the candidate union may contribute. */
export const SEARCH_CANDIDATE_CAP = 100;

export interface SearchQuery {
  /** The typed prefix, normalised. Compared for nip05 equality. */
  exact: string;
  /** The same string as a LIKE pattern, metacharacters escaped. */
  pattern: string;
}

/**
 * Normalise a typed prefix, or null when there is no usable query.
 *
 * PURE — this is the half verify/check-search.mjs replays against naive().
 *
 * Two things here are easy to get wrong and both are silent:
 *
 *  - `%` and `_` are LIKE metacharacters. Unescaped, a typed "50%" matches
 *    every profile in the table and "a_b" matches "axb". The backslash must be
 *    escaped FIRST or the escaping is self-defeating.
 *  - It deliberately does NOT lowercase. The generated columns were built with
 *    Postgres `lower()`, and JS `toLowerCase()` disagrees with it on some
 *    scripts (Turkish dotted/dotless i among them), so a JS-lowered needle
 *    would miss a SQL-lowered haystack. Lowering happens in the query, with the
 *    same function that built the column.
 */
export function normalizeSearchQuery(raw: unknown): SearchQuery | null {
  if (typeof raw !== 'string') return null;
  // The picker passes what the user typed, and they typed the '@' too.
  let q = raw.normalize('NFKC').trim().replace(/^@/, '').trim();
  if (!q) return null;
  // Control characters cannot appear in a name anyone can type.
  if (/[\x00-\x1f\x7f]/.test(q)) return null;
  q = q.slice(0, MAX_SEARCH_QUERY);
  if (q.length < MIN_SEARCH_QUERY) return null;
  // Backslash first: escaping it after % and _ would re-escape the escapes.
  const pattern = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return { exact: q, pattern };
}

/** Clamp a caller's `limit` into the range this service will serve. */
export function clampSearchLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SEARCH_RESULTS;
  return Math.min(Math.floor(n), MAX_SEARCH_RESULTS);
}

/**
 * Profiles whose name or display_name starts with the typed prefix, as SIGNED
 * kind:0 events — same contract as profilesFor, for the same reason.
 *
 * The candidate CTE caps each branch separately and orders inside each one, so
 * the cap is meaningful: capping without an ORDER BY drops the best match at
 * random, and not capping is unbounded on a two-letter prefix.
 *
 * Ranking is exact name match, then name prefix, then display_name prefix, then
 * nip05 — and nip05 is EQUALITY only, never a prefix. A nip05 here is a
 * self-asserted string nothing has verified, so letting it compete for short
 * prefixes is an impersonation ramp in a picker whose job is choosing who to
 * name. Ties break on shortest name (typing "ali" should surface "Ali" before
 * "Alistair Longname") and then on pubkey, so the order is deterministic — an
 * unstable order returns a different list to two visitors and makes a
 * CDN-cached response disagree with a live one.
 */
export async function searchProfiles(
  db: Db,
  q: SearchQuery,
  limit: number,
): Promise<StoredEvent[]> {
  const { rows } = await db.query<StoredEvent>(
    `with q as (select lower($1::text) as exact, lower($2::text) as pat),
     cand as (
       (select p.pubkey from profiles p, q
          where p.name_lower like q.pat escape '\\'
          order by length(p.name_lower), p.pubkey limit $4)
       union
       (select p.pubkey from profiles p, q
          where p.display_name_lower like q.pat escape '\\'
          order by length(p.display_name_lower), p.pubkey limit $4)
       union
       (select p.pubkey from profiles p, q where p.nip05_lower = q.exact limit $4)
     )
     select r.id, r.pubkey, r.kind, r.created_at, r.content, r.tags, r.sig
       from (
         select p.event_id as id, p.pubkey, 0 as kind, p.created_at,
                coalesce(p.content_raw, p.content::text) as content, p.tags, p.sig,
                case
                  when p.name_lower = q.exact or p.display_name_lower = q.exact then 0
                  when p.name_lower like q.pat escape '\\' then 1
                  when p.display_name_lower like q.pat escape '\\' then 2
                  else 3
                end as tier,
                coalesce(length(p.name_lower), length(p.display_name_lower), 99) as namelen
           from cand c join profiles p on p.pubkey = c.pubkey, q
       ) r
      order by r.tier, r.namelen, r.pubkey
      limit $3`,
    [q.exact, q.pattern, limit, SEARCH_CANDIDATE_CAP],
  );
  return rows;
}
