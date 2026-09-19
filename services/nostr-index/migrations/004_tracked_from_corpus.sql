-- Re-derive tracked_pubkeys from the corpus.
--
-- Until this change every stored event widened the tracked set, including the
-- reposts and zap receipts that the tracked subscription itself delivers — so a
-- repost of any note on the network brought its author into the 5,000-pubkey
-- window, stamped `now()`. That fed itself from the deploy on 2026-09-03 — 74 to
-- 405 tracked rebuilds a day — and from 2026-09-18 19:00 UTC about 35 an hour,
-- each one pulling in more strangers (see `TRACKED_SOURCE_KINDS` in
-- src/ingest.ts).
--
-- Fixing the rule stops new rows, but the window is `order by seen_at desc`, so
-- the rows the loop already stamped would hold it for months at the corpus's
-- own rate of new pubkeys — and the corpus authors they pushed out would stay
-- unsubscribed, their profiles and zaps unindexed, the whole time.
--
-- So, the table is rebuilt to mean what the new rule says it means:
--
--   * a row survives only when a kind:1 or kind:30311 names the pubkey, as
--     author or as a `p` tag — the same test `trackedFrom` applies at ingest;
--   * its `seen_at` becomes the newest such event's `created_at`, clamped to
--     now() so a future-dated event cannot pin a pubkey to the top.
--
-- Deleted events still count as sightings: a tombstone does not un-see the
-- author, and the safe direction here is to keep a row, not to drop one.
--
-- Nothing is lost that the relays do not still hold. This table is a cache
-- (001_init.sql) and the rows removed are exactly the ones the new rule would
-- never have written. Their `profiles` rows are left alone.

create temporary table corpus_seen on commit drop as
  select pubkey, max(created_at) as last_at
    from (
      select e.pubkey, e.created_at
        from events e
       where e.kind in (1, 30311)
      union all
      select t.value, e.created_at
        from event_tags t
        join events e on e.id = t.event_id
       where t.name = 'p' and e.kind in (1, 30311)
    ) s
   group by pubkey;

create index on corpus_seen (pubkey);

delete from tracked_pubkeys tp
 where not exists (select 1 from corpus_seen c where c.pubkey = tp.pubkey);

update tracked_pubkeys tp
   set seen_at = least(to_timestamp(c.last_at), now())
  from corpus_seen c
 where c.pubkey = tp.pubkey;
