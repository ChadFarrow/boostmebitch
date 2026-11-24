-- Community playlists: the tables behind lib/community/store.ts.
-- Idempotent: safe to run again. Apply with `npm run community:schema`.
create table if not exists community_playlists (
  id uuid primary key,
  owner_pubkey text not null,
  title text not null,
  description text not null default '',
  art_url text,
  songs jsonb not null,
  podcast_guid text not null unique,
  created_at timestamptz not null default date_trunc('milliseconds', now()),
  updated_at timestamptz not null default date_trunc('milliseconds', now()),
  deleted_at timestamptz,
  deleted_by text
);
-- A table made by an earlier version of this file keeps the old default until this runs.
-- Whole milliseconds, so a row inserted by hand survives the JS Date round trip in
-- `updated_at = $n` and can be edited.
alter table community_playlists alter column created_at set default date_trunc('milliseconds', now());
alter table community_playlists alter column updated_at set default date_trunc('milliseconds', now());
-- The maker's name, typed in the maker's NAME box (PlaylistDraft.ownerName); null for none.
-- Apply BEFORE deploying the code that reads it: that code selects this column.
alter table community_playlists add column if not exists owner_name text;
create index if not exists community_playlists_created_idx
  on community_playlists (created_at desc) where deleted_at is null;
create index if not exists community_playlists_owner_idx
  on community_playlists (owner_pubkey);

create table if not exists community_bans (
  pubkey text primary key,
  banned_at timestamptz not null default now(),
  banned_by text not null
);

-- Podcast Index notices (lib/community/pi-notify.ts, docs/feeds.md "Podcast Index").
-- Read only by the notice code and /admin, never by a feed: a deploy without them keeps
-- every feed working and sends no notice until this runs.
-- pi_feed_id: the feed's Podcast Index id, once a lookup found it.
-- pi_notified_at: the last notice (throttle). pi_first_notified_at: the first (the daily caps).
alter table community_playlists add column if not exists pi_feed_id bigint;
alter table community_playlists add column if not exists pi_notified_at timestamptz;
alter table community_playlists add column if not exists pi_first_notified_at timestamptz;
create index if not exists community_playlists_pi_first_idx
  on community_playlists (pi_first_notified_at) where pi_first_notified_at is not null;
