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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by text
);
create index if not exists community_playlists_created_idx
  on community_playlists (created_at desc) where deleted_at is null;
create index if not exists community_playlists_owner_idx
  on community_playlists (owner_pubkey);

create table if not exists community_bans (
  pubkey text primary key,
  banned_at timestamptz not null default now(),
  banned_by text not null
);
