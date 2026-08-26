-- Nostr read index. Every table here is a REBUILDABLE CACHE.
--
-- Relays remain the source of truth for everything in this schema. Dropping
-- the whole database must never lose user data, and no code anywhere may
-- publish, delete, or decide anything on the strength of a row in here.
--
-- What is deliberately absent is as load-bearing as what is present. There is
-- no table for kind:10333 (favorites), kind:10000 (mutes), kind:3 (follows),
-- kind:30078 (encrypted backups) or kind:4/1059 (direct messages). The first
-- four drive destructive replaceable-event writes on the client, and a stale
-- read from here would satisfy the removal test in mergeFavoritesList and
-- delete entries another app wrote. The last two are private by construction.

create table if not exists schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);

-- Raw signed events. Immutable once stored: an event id IS the hash of its
-- content, so a conflicting insert is the same event arriving from a second
-- relay, never an update.
create table if not exists events (
  id         text primary key,          -- 32-byte hex event id
  pubkey     text        not null,
  kind       int         not null,
  created_at bigint      not null,      -- unix seconds, from the event
  content    text        not null,
  tags       jsonb       not null,      -- FULL tag array, order preserved
  sig        text        not null,
  seen_at    timestamptz not null default now(),
  -- Set by a kind:5 whose author matches events.pubkey. Rows are never hard
  -- deleted: keeping the tombstone stops the next relay copy re-inserting it.
  deleted_at timestamptz
);

create index if not exists events_kind_created_idx
  on events (kind, created_at desc) where deleted_at is null;
create index if not exists events_author_kind_created_idx
  on events (pubkey, kind, created_at desc) where deleted_at is null;

-- Only NIP-01 single-letter (relay-indexable) tags land here. That is the same
-- set relays themselves index, and it keeps this table roughly one row per
-- meaningful reference rather than one per tag.
--
-- `pos` is the ordinal in the ORIGINAL tags array, not a counter over the
-- rows inserted here. TAG ORDER IS DATA in this project, and a caller
-- reconstructing context from these rows must see the real gaps.
create table if not exists event_tags (
  event_id text not null references events(id) on delete cascade,
  name     text not null,               -- 'i','p','e','k','t','a','q','d','r'
  value    text not null,               -- tag[1]
  pos      int  not null,
  primary key (event_id, pos)
);

create index if not exists event_tags_lookup_idx on event_tags (name, value, event_id);

-- kind:0 is replaceable, so a dedicated table turns a profile lookup into a
-- primary-key hit instead of a sort over every kind:0 the author ever wrote.
--
-- `content` is the RAW parsed kind:0 object. Never store the seven-field
-- whitelisted subset the app renders: a profile rebuilt from that silently
-- drops banner, website and every field another client set.
create table if not exists profiles (
  pubkey     text primary key,
  event_id   text        not null,
  created_at bigint      not null,
  content    jsonb       not null,
  tags       jsonb       not null,
  sig        text        not null,
  updated_at timestamptz not null default now()
);

-- Shared Podcast Index metadata cache. This is the favorites-hydration half:
-- it turns ~445 per-device requests into a handful of batched ones.
--
-- `miss = true` means PI was asked and answered "not found" (a 404 IS an
-- answer, and is cacheable). A row simply being ABSENT means we have not
-- asked, or could not ask — which is never cacheable and must not be
-- reported to a client as null.
create table if not exists pi_podcasts (
  guid       text primary key,          -- podcast:guid, or 'url:<feedUrl>'
  data       jsonb,
  miss       boolean     not null default false,
  fetched_at timestamptz not null default now()
);

create table if not exists pi_episodes (
  feed_guid  text        not null,
  item_guid  text        not null,
  data       jsonb,
  miss       boolean     not null default false,
  fetched_at timestamptz not null default now(),
  primary key (feed_guid, item_guid)
);

-- Pubkeys the indexer subscribes for kind:0 / 6 / 9735 / 5.
--
-- kind:9735 is NEVER subscribed unfiltered — that is a firehose of every zap
-- on the network. The explorer only ever needs zaps for a pubkey it is
-- already showing, so the tracked set is exactly the right scope.
create table if not exists tracked_pubkeys (
  pubkey   text primary key,
  reason   text        not null,        -- 'author' | 'p-tagged' | 'zapped'
  seen_at  timestamptz not null default now()
);

-- Podcast Index identifiers seen on an indexed note, queued for warm-fill.
create table if not exists pi_queue (
  key        text primary key,          -- 'p:<guid>' | 'e:<feedGuid>:<itemGuid>'
  kind       text        not null,      -- 'podcast' | 'episode'
  feed_guid  text        not null,
  item_guid  text,
  queued_at  timestamptz not null default now(),
  attempts   int         not null default 0,
  last_try   timestamptz
);
create index if not exists pi_queue_pending_idx on pi_queue (attempts, queued_at);

-- Per-relay backfill + liveness bookkeeping, so a restart resumes rather than
-- re-walking history from the top.
create table if not exists indexer_state (
  key           text primary key,       -- '<relayUrl>|<filterName>' or a global key
  relay_url     text,
  backfill_until bigint,                -- oldest created_at reached so far
  backfill_done boolean not null default false,
  last_event_at bigint,
  last_seen_at  timestamptz,
  status        text
);
