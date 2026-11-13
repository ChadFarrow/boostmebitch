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
create index if not exists community_playlists_created_idx
  on community_playlists (created_at desc) where deleted_at is null;
create index if not exists community_playlists_owner_idx
  on community_playlists (owner_pubkey);

create table if not exists community_bans (
  pubkey text primary key,
  banned_at timestamptz not null default now(),
  banned_by text not null
);
