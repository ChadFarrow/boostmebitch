'use client';

// "On this device", inside "Your playlists" on /playlists (`your-playlists.tsx`): the playlists the player's "+ PLAYLIST" (and
// the maker) hold here and have not sent. Without it a draft started from the
// player could be found again only by adding another song to it. Each row opens
// the maker on that draft, where PUBLISH or SAVE sends it.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/store';
import { storage, type PlaylistDraftSlot } from '@/lib/storage';
import { MIN_SONGS } from '@/lib/community/rules';
import { useGuestKey } from '@/lib/community/use-guest-key';
import { isNewDraftSlot, moveGuestNewDrafts } from '@/lib/community/local-drafts';

interface DraftRow {
  /** Whose slot: an npub, or null for the signed-out `:guest` one. */
  npub: string | null;
  slot: PlaylistDraftSlot;
  title: string;
  count: number;
  /** A published playlist's unsaved changes, not a new playlist. */
  edit: boolean;
}

function hrefFor(r: DraftRow): string {
  if (r.edit) return `/playlists/make?id=${encodeURIComponent(r.slot)}`;
  return r.slot === 'default' ? '/playlists/make' : `/playlists/make?draft=${encodeURIComponent(r.slot)}`;
}

/** `onRows`: how many drafts are listed, so the section can tell "nothing yet". */
export function LocalDraftsList({ onRows }: { onRows?: (n: number) => void } = {}) {
  const identity = useApp((s) => s.identity);
  const npub = identity?.npub ?? null;
  const guest = useGuestKey();
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (npub) moveGuestNewDrafts(npub);
    const owners: Array<string | null> = [npub];
    // A guest-made playlist's unsaved changes live under the guest key's npub.
    if (guest && guest.npub !== npub) owners.push(guest.npub);
    const out: DraftRow[] = [];
    for (const owner of owners) {
      for (const { slot, cache } of storage.playlistDraft.list(owner)) {
        const d = cache.draft;
        const edit = slot !== 'default' && !isNewDraftSlot(slot);
        // The guest key's own slot holds only edits; its new drafts are under `:guest`.
        if (owner !== npub && !edit) continue;
        if (!edit && !d.title.trim() && !d.songs.length) continue;
        out.push({ npub: owner, slot, title: d.title.trim() || 'Untitled playlist', count: d.songs.length, edit });
      }
    }
    setRows(out);
    onRows?.(out.length);
  }, [npub, guest, reload, onRows]);

  if (!rows.length) return null;

  const keyOf = (r: DraftRow) => `${r.npub ?? ':guest'}:${r.slot}`;

  return (
    <div className="mt-6" data-local-drafts>
      <h3 className="text-[11px] uppercase tracking-widest text-muted px-1">On this device</h3>
      <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted px-1">
        Not published yet. Only this device has these until you open one and press PUBLISH or SAVE.
      </p>
      <ul className="mt-2 divide-y divide-bone/10">
        {rows.map((r) => {
          const key = keyOf(r);
          return (
            <li key={key} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{r.title}</p>
                <p className="truncate text-xs text-muted">
                  {r.edit
                    ? `${r.count} songs · changes not saved`
                    : r.count >= MIN_SONGS
                      ? `${r.count} songs · ready to publish`
                      : `${r.count} of ${MIN_SONGS} songs · not published`}
                </p>
              </div>
              {confirm === key ? (
                <>
                  <span className="text-xs text-muted">{r.edit ? 'Drop these changes?' : 'Delete this draft?'}</span>
                  <button
                    type="button"
                    className="btn-mini"
                    onClick={() => {
                      storage.playlistDraft.clear(r.npub, r.slot === 'default' ? undefined : r.slot);
                      setConfirm(null);
                      setReload((n) => n + 1);
                    }}
                  >
                    YES
                  </button>
                  <button type="button" className="btn-mini" onClick={() => setConfirm(null)}>NO</button>
                </>
              ) : (
                <>
                  <Link href={hrefFor(r)} className="btn-mini" aria-label={`Open ${r.title}`}>OPEN</Link>
                  <button type="button" className="btn-mini" onClick={() => setConfirm(key)} aria-label={`Discard ${r.title}`}>
                    DISCARD
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
