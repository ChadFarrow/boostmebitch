-- Two things: repair the bytes a profile is served as, and index its name.
--
-- ---------------------------------------------------------------------------
-- 1. content_raw — the bytes the SIGNATURE covers
-- ---------------------------------------------------------------------------
--
-- `content` is jsonb, and jsonb is not a byte store. It sorts object keys by
-- (length, bytewise), drops duplicates, decodes escapes, and `::text` emits
-- `{"a": 1, "b": 2}` — with a space after every colon and comma. A kind:0 off
-- the wire has none of that. Measured on Postgres 16:
--
--   in   {"name":"alice","about":"hi","picture":"https://x/y.png","nip05":"a@b.c"}
--   out  {"name": "alice", "about": "hi", "nip05": "a@b.c", "picture": "https://x/y.png"}
--
-- getEventHash covers `content`, so those bytes hash to a different id and
-- `verifyEvent` returns false. `verifyAll` in lib/nostr/index-client.ts checks
-- every event this service serves — that is the point of it, it is what stops a
-- compromised index putting words under someone else's npub — so it has been
-- discarding essentially EVERY profile we serve, in feed bundles, live streams
-- and zap receipts alike. Nothing looked broken because each surface falls back
-- to relays and paints the name a second later.
--
-- `events.content` is plain text, so kind:1 was never affected. profiles is the
-- only table that puts content through jsonb.
--
-- Old rows cannot be backfilled — the raw string was never stored. They keep
-- returning the unverifiable text and the client keeps dropping them, which is
-- the safe direction, until the tracked kind:0 subscription rewrites them.
-- profiles is a declared rebuildable cache; this is what that is for.
--
-- `content` stays jsonb because the search columns below are derived from it.
alter table profiles add column if not exists content_raw text;

-- ---------------------------------------------------------------------------
-- 2. Name search, for the @-mention picker
-- ---------------------------------------------------------------------------
--
-- The query is a 2-3 character LEFT-ANCHORED prefix, typed per keystroke. That
-- is a btree range scan and nothing else.
--
-- pg_trgm was rejected: a 2-character pattern produces no trigrams at all, so
-- the GIN degrades to a full scan on the shortest and most frequent query —
-- worst exactly where it matters — and it needs a CREATE EXTENSION on the
-- Railway database, a new deploy prerequisite for the case it handles worst.
--
-- A tsvector column was rejected as a heavier structure answering a different
-- question: `english` stems (wrong for names) and `simple` still tokenises on
-- its own rules, so `dj_alice` and `alice.btc` split unpredictably.
--
-- Generated STORED columns rather than a companion table or plain expression
-- indexes: the `on conflict … do update` in store.ts maintains them with no
-- code change, so they cannot drift from the content they are derived from.
-- `->>`, `btrim`, `nullif` and `lower` are all IMMUTABLE, so the expressions
-- are legal in a generated column.
alter table profiles
  add column if not exists name_lower text
    generated always as (lower(nullif(btrim(content->>'name'), ''))) stored,
  add column if not exists display_name_lower text
    generated always as (lower(nullif(btrim(content->>'display_name'), ''))) stored,
  add column if not exists nip05_lower text
    generated always as (lower(nullif(btrim(content->>'nip05'), ''))) stored;

-- text_pattern_ops, NOT the default opclass. A default btree only serves
-- LIKE 'x%' under the C collation, and this database's collation is not ours to
-- assume. Partial on NOT NULL because a profile with no name is most of the
-- reason a row exists at all and never matches a prefix.
create index if not exists profiles_name_lower_prefix_idx
  on profiles (name_lower text_pattern_ops) where name_lower is not null;
create index if not exists profiles_display_name_lower_prefix_idx
  on profiles (display_name_lower text_pattern_ops) where display_name_lower is not null;

-- nip05 is matched on EQUALITY only, never as a prefix, so the default opclass
-- is right here. A nip05 in this table is a SELF-ASSERTED string out of a
-- kind:0 that nothing has verified; prefix-matching it would let
-- `alice@evil.example` compete for "ali" with the real Alice, in a picker whose
-- whole job is choosing who to name.
create index if not exists profiles_nip05_lower_idx
  on profiles (nip05_lower) where nip05_lower is not null;
