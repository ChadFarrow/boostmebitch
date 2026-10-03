-- Remember every kind:5 target, so a deletion that arrives BEFORE its note
-- still applies when the note turns up.
--
-- Until this change a kind:5 was consumed at ingest by an UPDATE over the
-- events that already existed and then forgotten. Relays serve history out of
-- order, and the two halves reach this index through different subscriptions —
-- the kind:5 through the authors-scoped tracked group, the note through a core
-- filter or a backfill page that may be days behind — so "deletion first" is an
-- ordinary arrival order. The note was then inserted with `deleted_at` null and
-- served on every surface, a note its author had asked to delete.
--
-- `(event_id, pubkey)`, never `event_id` alone: a deletion only ever applies to
-- its OWN author's events, and the insert path matches on both, so a kind:5
-- naming someone else's note is stored and can never match it.
--
-- Like every table here this is a rebuildable cache (001_init.sql). Dropping it
-- forgets requests the relays still hold, and the tracked subscription carries
-- no `since`, so its next rebuild replays them.

create table if not exists deletion_requests (
  event_id   text        not null,      -- the id the kind:5 names
  pubkey     text        not null,      -- the kind:5's author
  seen_at    timestamptz not null default now(),
  primary key (event_id, pubkey)
);

-- Backfill nothing: the kind:5 events that already ran were never stored, so
-- there is nothing here to derive them from. The rows they tombstoned keep
-- their `deleted_at`, which is the half that mattered.
