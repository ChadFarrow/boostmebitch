-- The head of every NIP-53 broadcast: its newest version that /feed/live can
-- serve (status `live` or `planned`), one row per (pubkey, address).
--
-- Why a table. kind:30311 is addressable and a streaming client republishes it
-- every few seconds, so `events` holds every VERSION: on 2026-11-17 production
-- had 503,573 of them, 58,612 inside the route's 7-day window, for 262
-- broadcasts. `liveStreams` deduped them at read time — every version's row,
-- its jsonb tags and a `d` lookup in `event_tags` — and took 29.7 s against the
-- app proxy's 6 s timeout, so /feed/live answered 503 on every call while each
-- call left that query running. Same reasoning as `profiles` for kind:0: keep
-- the current one where a primary-key read finds it.
--
-- `addr` is the first indexable `d` value, or the event id when there is none
-- (src/ingest.ts `liveHeadAddress`). src/store.ts keeps the table current:
-- every servable version is OFFERED and replaces the head only when newer, and
-- a kind:5 that tombstones a head promotes the next-newest surviving version.
--
-- No foreign key to `events`, on purpose: adding one takes a SHARE ROW
-- EXCLUSIVE lock on `events`, which blocks every insert for the rest of this
-- transaction, backfill included. The only hard delete is src/retention.ts,
-- which never deletes a version this table names, and the route joins `events`
-- and re-checks `deleted_at` anyway.
--
-- A small new table, so its indexes are built here, not by hand: nothing else
-- can be writing to a table this file creates.
create table if not exists live_heads (
  pubkey     text   not null,
  addr       text   not null,
  event_id   text   not null,
  created_at bigint not null,
  primary key (pubkey, addr)
);

create index if not exists live_heads_created_idx on live_heads (created_at desc);
-- The delete path finds a retired head by its event id.
create index if not exists live_heads_event_idx on live_heads (event_id);

-- Backfill with the EXACT query the route used, over the same 7-day window
-- (LIVE_WINDOW_SECS in src/ingest.ts), so the first heads are the old answer by
-- construction. Older versions are not needed: the route never serves a head
-- older than the window, the window only moves forward, and any later version
-- of an older broadcast arrives through ingest and becomes its head there.
-- Read-only on `events`, so ingest keeps running while it does (~30 s on
-- production, measured as the route itself).
insert into live_heads (pubkey, addr, event_id, created_at)
select distinct on (e.pubkey, coalesce(d.value, e.id))
       e.pubkey, coalesce(d.value, e.id), e.id, e.created_at
  from events e
  left join lateral (
    select t.value from event_tags t
     where t.event_id = e.id and t.name = 'd'
     order by t.pos limit 1
  ) d on true
 where e.kind = 30311 and e.deleted_at is null
   and e.created_at >= extract(epoch from now())::bigint - 7 * 86400
   and exists (select 1 from jsonb_array_elements(e.tags) tag
                where tag->>0 = 'status' and tag->>1 in ('live', 'planned'))
 order by e.pubkey, coalesce(d.value, e.id), e.created_at desc
on conflict do nothing;
