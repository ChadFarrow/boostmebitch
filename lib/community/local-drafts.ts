'use client';

// The playlist drafts on THIS device, as the player's "+ PLAYLIST" sees them.
// Browser-only (it reads `lib/storage.ts`). Nothing here sends anything: an add
// writes a draft, and only the maker's PUBLISH or SAVE signs and sends it, once,
// with one podping — never one per song (docs/feeds.md, "Community playlists").

import {
  storage, NEW_DRAFT_PREFIX,
  type PlaylistDraftCache, type PlaylistDraftSlot,
} from '@/lib/storage';
import { addSong, type AddSongResult, type PlaylistSong } from './rules';
import { fetchPlaylist } from './client';
import { randomId } from '@/lib/util';

/** What a song shows as in the maker's rows, before any fetch. */
export type SongLabel = PlaylistDraftCache['labels'][string];

/** `new-<id>`: a further unpublished draft. The maker opens one at `?draft=<slot>`. */
export function isNewDraftSlot(slot: string | null | undefined): slot is `new-${string}` {
  return !!slot && slot.startsWith(NEW_DRAFT_PREFIX) && slot.length > NEW_DRAFT_PREFIX.length
    && !slot.includes(':') && slot.length <= 64;
}

/** An empty unpublished draft. */
function emptyCache(title: string): PlaylistDraftCache {
  return {
    draft: { title, description: '', ownerName: '', artUrl: null, songs: [] },
    editingId: null, expectedUpdatedAt: null, labels: {}, createdAt: Date.now(),
  };
}

function withSong(cache: PlaylistDraftCache, song: PlaylistSong, label: SongLabel | null) {
  const r = addSong(cache.draft.songs, song);
  if (r.result !== 'added') return { cache, result: r.result };
  return {
    cache: {
      ...cache,
      draft: { ...cache.draft, songs: r.songs },
      labels: label ? { ...cache.labels, [song.itemGuid]: label } : cache.labels,
    },
    result: r.result,
  };
}

/** `'not-saved'`: the browser refused the write (full or blocked storage), so nothing changed. */
export type DraftAddOutcome = AddSongResult | 'not-saved' | 'not-loaded';

/**
 * Start a new unpublished draft named `title` holding `song`. Returns its slot,
 * or null when the browser refused the write.
 */
export function startDraftWith(
  npub: string | null, title: string, song: PlaylistSong, label: SongLabel | null,
): `new-${string}` | null {
  const slot = `${NEW_DRAFT_PREFIX}${randomId()}` as const;
  const { cache } = withSong(emptyCache(title.trim()), song, label);
  return storage.playlistDraft.set(npub, cache, slot) ? slot : null;
}

/** Add `song` to an UNPUBLISHED draft (the default slot or a `new-<id>` one). */
export function addToLocalDraft(
  npub: string | null, slot: PlaylistDraftSlot, song: PlaylistSong, label: SongLabel | null,
): DraftAddOutcome {
  const editId = slot === 'default' ? undefined : slot;
  const cur = storage.playlistDraft.get(npub, editId) ?? emptyCache('');
  const { cache, result } = withSong(cur, song, label);
  if (result !== 'added') return result;
  return storage.playlistDraft.set(npub, cache, editId) ? 'added' : 'not-saved';
}

/**
 * Add `song` to a PUBLISHED playlist's unsaved changes on this device. With no
 * changes held yet, they start from the stored playlist and the version it was
 * read at, exactly as the maker's EDIT view starts: a later SAVE against a
 * playlist changed elsewhere then gets the 409 "changed elsewhere" warning, never
 * a silent overwrite. `slotNpub` is whose slot holds the edit: the account's npub,
 * or the guest key's for a playlist this browser made with no account.
 */
export async function addToPublished(
  slotNpub: string, id: string, song: PlaylistSong, label: SongLabel | null,
): Promise<DraftAddOutcome> {
  let cur = storage.playlistDraft.get(slotNpub, id);
  if (!cur) {
    const p = await fetchPlaylist(id);
    if (!p) return 'not-loaded';
    // Read the slot AGAIN after the fetch: the maker, open on this playlist, may
    // have written its changes meanwhile, and a seed built from the server would
    // overwrite them.
    cur = storage.playlistDraft.get(slotNpub, id) ?? {
      draft: {
        title: p.title, description: p.description, ownerName: p.ownerName ?? '',
        artUrl: p.artUrl ?? null, songs: p.songs.map((s) => ({ feedGuid: s.feedGuid, itemGuid: s.itemGuid })),
      },
      editingId: id, expectedUpdatedAt: p.updatedAt, labels: {}, createdAt: Date.now(),
    };
  }
  const { cache, result } = withSong(cur, song, label);
  if (result !== 'added') return result;
  return storage.playlistDraft.set(slotNpub, cache, id) ? 'added' : 'not-saved';
}

/**
 * How many songs a published playlist's held changes ADD over the stored list:
 * the "+3 unsaved" hint. `storedCount` is the stored playlist's song count.
 */
export function heldExtra(slotNpub: string, id: string, storedCount: number): number {
  const c = storage.playlistDraft.get(slotNpub, id);
  return c ? Math.max(0, c.draft.songs.length - storedCount) : 0;
}

/**
 * The `new-<id>` drafts made signed out MOVE to the account that signs in, as the
 * maker's default `:guest` draft does: left under `:guest`, the next account to
 * sign in on this device would take them. Each is cleared from `:guest` only
 * once the account's copy LANDED, so a refused write never loses it from both.
 * A slot the account already holds is left where it is.
 */
export function moveGuestNewDrafts(npub: string): void {
  for (const { slot, cache } of storage.playlistDraft.list(null)) {
    if (!isNewDraftSlot(slot)) continue;
    if (storage.playlistDraft.get(npub, slot)) continue;
    if (storage.playlistDraft.set(npub, { ...cache, editingId: null, expectedUpdatedAt: null }, slot)) {
      storage.playlistDraft.clear(null, slot);
    }
  }
}
