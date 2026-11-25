'use client';

// "+ PLAYLIST": save the song on screen to a playlist instead of to favorites
// (Chad, 2026-11-25: someone making a playlist for an event wanted to collect
// songs while listening, without putting them in their favorites). It sits
// BESIDE the heart, never inside it: the heart stays one tap, favorites only.
//
// An add never sends anything. It writes a draft on this device
// (`lib/community/local-drafts.ts`): a new unpublished playlist, or the unsaved
// changes of a published one. The maker's PUBLISH or SAVE then signs once and
// sends one podping, however many songs were added (docs/feeds.md).

import { useEffect, useRef, useState } from 'react';
import { useApp, isMusicItem } from '@/lib/store';
import { storage, type PlaylistDraftSlot } from '@/lib/storage';
import { ModalShell } from '@/components/modal-shell';
import { COMMUNITY_PLAYLISTS_ON } from '@/lib/curated-playlists';
import { useGuestKey } from '@/lib/community/use-guest-key';
import { fetchCommunityPlaylists } from '@/lib/community/client';
import { MIN_SONGS, MAX_TITLE_LEN, type CommunityPlaylistSummary } from '@/lib/community/rules';
import { textHoldsSecret } from '@/lib/nostr/npub-input';
import {
  addToLocalDraft, addToPublished, heldExtra, isNewDraftSlot, moveGuestNewDrafts, startDraftWith,
  type DraftAddOutcome, type SongLabel,
} from '@/lib/community/local-drafts';
import { whyNotPlayable } from './song-check';
import { canFavoriteEpisode } from '@/components/fav-heart';
import type { Episode, Podcast, ValueTimeSplit } from '@/lib/types';

/** The song a "+ PLAYLIST" saves: the TRACK's own feed, never a playlist that lists it. */
export interface SaveTarget {
  feedGuid: string;
  itemGuid: string;
  label: SongLabel;
  /** Its audio file when known, so the playable check asks nothing twice. */
  enclosureUrl?: string;
}

/**
 * The target for an episode row or the item in the player, or null when there is
 * no song to save. The feed guid is chosen as `<FavEpisodeHeart>` chooses it: the
 * episode's own `podcastGuid` first, because inside a `musicL` playlist the
 * container is not the track's parent and its guid would save the PLAYLIST.
 * Music only (`isMusicItem`, which counts a playlist's tracks): a community
 * playlist is `musicL`, and the server refuses a song that is not music.
 */
export function targetFromEpisode(episode: Episode, podcast?: Podcast | null): SaveTarget | null {
  if (!podcast || !canFavoriteEpisode(episode, podcast)) return null;
  if (!isMusicItem({ episode, podcast })) return null;
  const feedGuid = episode.podcastGuid || podcast.podcastGuid;
  if (!episode.guid || !feedGuid) return null;
  const containerIsParent = podcast.podcastGuid === feedGuid;
  const artist = episode.feedTitle || (containerIsParent ? podcast.title : undefined);
  const image = episode.image || episode.feedImage || (containerIsParent ? podcast.image : undefined);
  return {
    feedGuid, itemGuid: episode.guid,
    label: { title: episode.title || 'Untitled', ...(artist ? { artist } : {}), ...(image ? { image } : {}) },
    ...(episode.enclosureUrl ? { enclosureUrl: episode.enclosureUrl } : {}),
  };
}

/**
 * The target for a `<podcast:valueTimeSplit>` window or a live block, or null.
 * The same feed-guid rule as `<FavTrackHeart>`: `parentFeedGuid` overrides the
 * wire value, and `null` withdraws it (a publisher feed, which no song lives in).
 */
export function targetFromSplit(split: ValueTimeSplit): SaveTarget | null {
  const itemGuid = split.remoteItem?.itemGuid;
  const feedGuid = split.parentFeedGuid === null ? undefined : split.parentFeedGuid ?? split.remoteItem?.feedGuid;
  if (!itemGuid || !feedGuid) return null;
  const medium = split.remoteItem?.medium?.toLowerCase();
  // An unknown medium is let through: the server checks again at PUBLISH.
  if (medium && medium !== 'music') return null;
  return {
    feedGuid, itemGuid,
    label: {
      title: split.title || 'Untitled',
      ...(split.artist || split.feedTitle ? { artist: split.artist || split.feedTitle } : {}),
      ...(split.image ? { image: split.image } : {}),
    },
  };
}

type Size = 'sm' | 'tile';

function triggerClasses(size: Size) {
  if (size === 'tile') return 'tile hover:border-bolt/70 hover:text-bolt';
  // The heart's 'sm' chip (`fav-heart.tsx`): 44×44 below sm:, the word from sm:.
  return 'inline-flex items-center justify-center gap-1.5 px-3 font-mono uppercase tracking-wider text-xs leading-none border transition active:translate-y-px flex-shrink-0 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 border-bone/40 text-bone/70 hover:border-bolt/70 hover:text-bolt';
}

/**
 * The "+ PLAYLIST" control. Renders nothing while the playlist maker is off
 * (`COMMUNITY_PLAYLISTS_ON`) or when there is no song to save.
 *
 * **Inside a `⋯` menu, pass `onOpen` and render `<SaveToPlaylistSheet>` OUTSIDE
 * the menu.** A menu closes on a press or an outside click, and a click inside
 * the sheet is outside the menu: a sheet owned by the button would unmount with
 * the menu under the user's finger (STREAM's dialog lives outside for the same reason).
 */
export function SaveToPlaylistButton({
  target,
  size = 'sm',
  onOpen,
}: {
  target: SaveTarget | null;
  size?: Size;
  onOpen?: (target: SaveTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!COMMUNITY_PLAYLISTS_ON || !target) return null;
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          // Rows are seek and open buttons: the press must not reach them.
          e.stopPropagation();
          e.preventDefault();
          if (onOpen) onOpen(target);
          else setOpen(true);
        }}
        className={triggerClasses(size)}
        aria-haspopup="dialog"
        aria-label={`Save ${target.label.title} to a playlist`}
        title="Save to a playlist"
        data-save-to-playlist
      >
        <span aria-hidden className={`inline-block w-[0.9em] text-center ${size === 'sm' ? 'text-base' : 'text-lg'} leading-none`}>+</span>
        <span className={size === 'sm' ? 'hidden sm:inline' : undefined}>PLAYLIST</span>
      </button>
      {open && <SaveToPlaylistSheet target={target} onClose={() => setOpen(false)} />}
    </>
  );
}

/** A row in the sheet: an unpublished draft, or a published playlist of this person. */
type Row =
  | { kind: 'local'; slot: PlaylistDraftSlot; title: string; count: number; npub: string | null }
  | { kind: 'published'; id: string; title: string; count: number; held: number; slotNpub: string };

type RowState = 'busy' | DraftAddOutcome | { refused: string };

const OUTCOME_TEXT: Record<Exclude<DraftAddOutcome, 'added'>, string> = {
  already: 'Already in it',
  full: 'This playlist is full',
  'not-saved': 'Not saved: this browser refused to store it',
  'not-loaded': 'Could not load this playlist. Try again.',
};

export function SaveToPlaylistSheet({ target, onClose }: { target: SaveTarget; onClose: () => void }) {
  const identity = useApp((s) => s.identity);
  const npub = identity?.npub ?? null;
  const pubkey = identity?.pubkey ?? null;
  // The guest key's PUBLIC half, read only: looking at this sheet never makes one.
  const guest = useGuestKey();
  const [local, setLocal] = useState<Row[]>([]);
  // `null` while loading; `'failed'` when no list could be read (never "you have none").
  const [published, setPublished] = useState<Row[] | 'failed' | null>(null);
  const [states, setStates] = useState<Record<string, RowState>>({});
  // The playable check runs once per sheet, on the first add.
  const [verdict, setVerdict] = useState<Promise<string | null> | null>(null);
  const [naming, setNaming] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newNote, setNewNote] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // Where focus goes after CREATE: the name form unmounts with the focused CREATE
  // in it, and focus left on <body> is outside the sheet, so Escape and Tab stopped working.
  const newBtnRef = useRef<HTMLButtonElement>(null);
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    if (refocus && !naming) { newBtnRef.current?.focus(); setRefocus(false); }
  }, [refocus, naming]);

  // The unpublished drafts on this device.
  useEffect(() => {
    if (npub) moveGuestNewDrafts(npub);
    const rows: Row[] = [];
    for (const { slot, cache } of storage.playlistDraft.list(npub)) {
      const isDefault = slot === 'default';
      if (!isDefault && !isNewDraftSlot(slot)) continue;
      const d = cache.draft;
      // The maker's default slot is shown only when something is in it.
      if (isDefault && !d.title.trim() && !d.songs.length) continue;
      rows.push({ kind: 'local', slot, title: d.title.trim() || 'Untitled playlist', count: d.songs.length, npub });
    }
    setLocal(rows);
  }, [npub, reload]);

  // The published playlists this person may edit: the account's, and those this
  // browser made with no account (its guest key).
  useEffect(() => {
    if (guest === undefined) return;
    let live = true;
    setPublished(null);
    (async () => {
      const owners: Array<{ hex: string; slotNpub: string }> = [];
      if (pubkey && npub) owners.push({ hex: pubkey, slotNpub: npub });
      if (guest && guest.pubkey !== pubkey) owners.push({ hex: guest.pubkey, slotNpub: guest.npub });
      if (!owners.length) { if (live) setPublished([]); return; }
      const lists = await Promise.all(owners.map((o) => fetchCommunityPlaylists(o.hex)));
      if (!live) return;
      if (lists.every((l) => l === null)) { setPublished('failed'); return; }
      const rows: Row[] = [];
      lists.forEach((l, i) => {
        for (const p of (l ?? []) as CommunityPlaylistSummary[]) {
          rows.push({
            kind: 'published', id: p.id, title: p.title, count: p.songCount,
            held: heldExtra(owners[i].slotNpub, p.id, p.songCount), slotNpub: owners[i].slotNpub,
          });
        }
      });
      setPublished(rows);
    })();
    return () => { live = false; };
  }, [guest, pubkey, npub, reload]);

  /** The playable check, asked once. Its reason, or null when the song may go in. */
  function playable(): Promise<string | null> {
    if (verdict) return verdict;
    const p = whyNotPlayable(target.feedGuid, target.itemGuid, target.enclosureUrl ? { enclosureUrl: target.enclosureUrl } : {});
    setVerdict(p);
    return p;
  }

  const song = { feedGuid: target.feedGuid, itemGuid: target.itemGuid };
  const keyOf = (r: Row) => (r.kind === 'local' ? `l:${r.slot}` : `p:${r.id}`);

  async function add(r: Row) {
    const key = keyOf(r);
    if (states[key] === 'busy' || states[key] === 'added') return;
    setStates((s) => ({ ...s, [key]: 'busy' }));
    const why = await playable();
    if (why) { setStates((s) => ({ ...s, [key]: { refused: why } })); return; }
    const out = r.kind === 'local'
      ? addToLocalDraft(r.npub, r.slot, song, target.label)
      : await addToPublished(r.slotNpub, r.id, song, target.label);
    setStates((s) => ({ ...s, [key]: out }));
    if (out === 'added') {
      if (r.kind === 'local') setLocal((rows) => rows.map((x) => (keyOf(x) === key && x.kind === 'local' ? { ...x, count: x.count + 1 } : x)));
      else setPublished((rows) => Array.isArray(rows) ? rows.map((x) => (keyOf(x) === key && x.kind === 'published' ? { ...x, held: x.held + 1 } : x)) : rows);
    }
  }

  async function create() {
    const title = newTitle.trim();
    if (!title) { setNewNote('Give the playlist a name.'); return; }
    if (title.length > MAX_TITLE_LEN) { setNewNote(`The name can be up to ${MAX_TITLE_LEN} characters.`); return; }
    // The title is published later: a pasted key must not go into it.
    if (textHoldsSecret(title)) { setNewNote('That looks like a secret key. Do not put it in a playlist name.'); return; }
    setNewNote('Checking the song…');
    const why = await playable();
    if (why) { setNewNote(`This song cannot go in a playlist: ${why}`); return; }
    const slot = startDraftWith(npub, title, song, target.label);
    if (!slot) { setNewNote('Not saved: this browser refused to store it.'); return; }
    setNaming(false); setNewTitle(''); setNewNote(null); setRefocus(true);
    setStates((s) => ({ ...s, [`l:${slot}`]: 'added' }));
    setReload((n) => n + 1);
  }

  function status(r: Row) {
    const st = states[keyOf(r)];
    if (!st) return null;
    if (st === 'busy') return <span className="text-[11px] text-muted">…</span>;
    if (st === 'added') return <span className="text-[11px] text-bolt" data-added>✓ ADDED</span>;
    if (typeof st === 'object') return <span className="text-[11px] text-muted">{st.refused}</span>;
    return <span className="text-[11px] text-muted">{OUTCOME_TEXT[st]}</span>;
  }

  function rowLine(r: Row) {
    if (r.kind === 'local') {
      return r.count >= MIN_SONGS
        ? `${r.count} songs · not published`
        : `${r.count} of ${MIN_SONGS} songs · not published`;
    }
    return r.held > 0 ? `${r.count} songs · +${r.held} not saved` : `${r.count} songs · published`;
  }

  function renderRow(r: Row) {
    const st = states[keyOf(r)];
    return (
      <li key={keyOf(r)} className="flex items-center gap-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{r.title}</p>
          <p className="truncate text-xs text-muted">{rowLine(r)}</p>
          {status(r)}
        </div>
        <button
          type="button"
          className="btn-mini min-w-[4.5rem] shrink-0"
          onClick={() => add(r)}
          disabled={st === 'busy' || st === 'added'}
          aria-label={`Add to ${r.title}`}
        >
          {st === 'added' ? '✓' : '+ ADD'}
        </button>
      </li>
    );
  }

  return (
    // A React event from inside a portal still bubbles up the COMPONENT tree, and
    // this sheet is mounted inside list rows whose own press plays the track: a
    // CREATE or ADD here started playback behind the sheet. Nothing pressed in
    // the sheet may reach the row. `contents` keeps the span out of the layout.
    <span
      className="contents"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
    <ModalShell onClose={onClose} label="Save to playlist" className="w-full max-w-md" closeButton clearsPlayer={false}>
      <div className="px-4 pt-4 pb-5">
        <h2 className="font-display text-xl">Save to playlist</h2>
        <p className="truncate text-xs text-muted mt-1">
          {target.label.title}{target.label.artist ? ` · ${target.label.artist}` : ''}
        </p>
        <p className="text-xs text-bone/70 mt-3 leading-relaxed">
          Songs are kept on this device. Nothing is published until you open the playlist
          in PLAYLISTS and press PUBLISH or SAVE. A new playlist needs {MIN_SONGS} songs.
        </p>

        <div className="mt-4">
          {naming ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => { e.preventDefault(); void create(); }}
            >
              <input
                className="input flex-1 min-w-0"
                value={newTitle}
                onChange={(e) => { setNewTitle(e.target.value); setNewNote(null); }}
                placeholder="Playlist name"
                aria-label="New playlist name"
                maxLength={MAX_TITLE_LEN}
                autoFocus
              />
              <button type="submit" className="btn-bolt btn-compact shrink-0">CREATE</button>
              {newNote && <p className="w-full text-xs text-muted">{newNote}</p>}
            </form>
          ) : (
            <button ref={newBtnRef} type="button" className="btn-mini" onClick={() => setNaming(true)} data-new-playlist>
              + NEW PLAYLIST
            </button>
          )}
        </div>

        <h3 className="text-[11px] uppercase tracking-widest text-muted mt-5">On this device</h3>
        {local.length ? (
          <ul className="divide-y divide-bone/10">{local.map(renderRow)}</ul>
        ) : (
          <p className="text-xs text-muted py-2">No unpublished playlists on this device.</p>
        )}

        {(identity || guest) && (
          <>
            <h3 className="text-[11px] uppercase tracking-widest text-muted mt-5">Published</h3>
            {published === null ? (
              <p className="text-xs text-muted py-2">Loading your playlists…</p>
            ) : published === 'failed' ? (
              <p className="text-xs text-muted py-2">
                Could not load your playlists.{' '}
                <button type="button" className="btn-inline" onClick={() => setReload((n) => n + 1)}>Try again</button>
              </p>
            ) : published.length ? (
              <ul className="divide-y divide-bone/10">{published.map(renderRow)}</ul>
            ) : (
              <p className="text-xs text-muted py-2">You have not published a playlist yet.</p>
            )}
          </>
        )}
      </div>
    </ModalShell>
    </span>
  );
}
