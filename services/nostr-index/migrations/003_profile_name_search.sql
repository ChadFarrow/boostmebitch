-- Index a profile's name, for the @-mention picker.
--
-- The `content_raw` repair that used to share this file shipped separately as
-- migration 002 (#306), so this is the search half alone. `content` is still
-- jsonb, which is what these columns are derived from — deriving them from the
-- raw text would mean parsing JSON in SQL on every write.
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
