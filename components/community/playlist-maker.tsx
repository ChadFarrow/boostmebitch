'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/store';
import { storage, type PlaylistDraftCache } from '@/lib/storage';
import { ModalShell } from '@/components/modal-shell';
import { RowThumb } from '@/components/chapter-ui';
import { artCandidates } from '@/lib/util';
import { SongPreviewButton } from '@/components/community/song-preview-button';
import { cleanText } from '@/lib/community/clean-text';
import {
  MAX_TITLE_LEN, MIN_SONGS, validatePlaylistDraft,
  type ArtRefusal, type CommunityPlaylistSummary, type DraftProblem, type PlaylistDraft, type PlaylistSong,
} from '@/lib/community/rules';
import {
  NoSignerError, SignTimeoutError, deleteOwnPlaylist, fetchCommunityPlaylists, fetchPlaylist, publishPlaylist, savePlaylist,
} from '@/lib/community/client';
import { COMMUNITY_PLAYLISTS_ON, communityFeedUrl } from '@/lib/curated-playlists';
import { textHoldsSecret } from '@/lib/nostr/npub-input';
import { PlaylistPublished } from './playlist-published';
import { AddSongsSheet } from './add-songs-sheet';

// The resolver's page size (`MAX_BATCH` in lib/pi-batch.ts, which is server-only and cannot be imported here).
const RESOLVE_PAGE = 100;

type Labels = Record<string, { title: string; artist?: string; image?: string }>;

/** A server refusal, per problem. */
type Refusal =
  | DraftProblem
  | { kind: 'art'; reason: ArtRefusal }
  | { kind: 'song-not-found'; itemGuid: string }
  | { kind: 'not-music'; itemGuid: string };

const ART_WORDS: Record<ArtRefusal, string> = {
  'not-square': 'The picture must be square.',
  'too-small': 'The picture must be at least 1400 × 1400 px.',
  'too-large': 'The picture must be at most 3000 × 3000 px.',
  format: 'Use a PNG or JPEG picture.',
  alpha: 'The picture must not be transparent.',
  'not-image': 'That link is not a picture we can read.',
};

function problemText(p: Refusal, labels: Labels): string {
  const song = (guid: string) => labels[guid]?.title ?? 'A song';
  switch (p.kind) {
    case 'title-missing': return 'Add a title.';
    case 'title-too-long': return 'The title is too long.';
    case 'description-too-long': return 'The description is too long.';
    case 'too-few-songs': return `Add ${MIN_SONGS - p.have} more ${MIN_SONGS - p.have === 1 ? 'song' : 'songs'}.`;
    case 'too-many-songs': return 'The playlist has too many songs.';
    case 'duplicate-song': return `${song(p.itemGuid)} is in the playlist twice.`;
    case 'bad-song': return 'One song in the playlist is not valid. Remove it.';
    case 'art-not-https': return 'The picture link must start with https://';
    case 'art-bad-link': return 'The picture link is not a valid address.';
    // Never quotes the text: the key must not be printed again anywhere.
    case 'secret': return `The ${p.field} holds what looks like a secret key or a wallet connection. Remove it: a playlist is public.`;
    case 'art': return ART_WORDS[p.reason] ?? ART_WORDS['not-image'];
    case 'song-not-found': return `${song(p.itemGuid)} was not found. Remove it and try again.`;
    case 'not-music': return `${song(p.itemGuid)} is not a music track. Remove it and try again.`;
  }
}

/**
 * Why PUBLISH is off, in one short line; null when it is on. A secret key in the
 * title or description comes first: it must be removed before anything is sent.
 */
function whyNot(d: PlaylistDraft): string | null {
  const v = validatePlaylistDraft(d, textHoldsSecret);
  if (v.ok) return null;
  const order: DraftProblem['kind'][] = ['secret', 'too-few-songs', 'title-missing'];
  const first = order.map((k) => v.problems.find((p) => p.kind === k)).find(Boolean) ?? v.problems[0];
  return problemText(first, {}).replace(/\.$/, '');
}

const ICON_BTN = 'inline-flex h-8 w-8 items-center justify-center border border-bone/30 text-bone/80 hover:border-bone/60 hover:text-bone disabled:opacity-30';

export function PlaylistMaker() {
  const identity = useApp((s) => s.identity);
  const setSignInOpen = useApp((s) => s.setSignInOpen);

  // The account the form on screen belongs to. A draft is written only while this equals
  // the signed-in npub, so one account's form is never saved under another's key.
  const [formNpub, setFormNpub] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [artUrl, setArtUrl] = useState('');
  const [songs, setSongs] = useState<PlaylistSong[]>([]);
  const [labels, setLabels] = useState<Labels>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState<string | null>(null);
  // Set by a user change, never by a load: only then is a draft written.
  const [dirty, setDirty] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  // Opens <AddSongsSheet>.
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusals, setRefusals] = useState<Refusal[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleted, setDeleted] = useState<'deleted' | 'gone' | null>(null);
  const [mounted, setMounted] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const [published, setPublished] = useState<{
    id: string; feedUrl: string; title: string; tracks: number; summary: CommunityPlaylistSummary | null;
  } | null>(null);

  const npub = identity?.npub ?? null;
  const pubkey = identity?.pubkey ?? null;
  const name = identity?.profile?.display_name || identity?.profile?.name || (npub ? `${npub.slice(0, 12)}…` : '');
  const ready = !!npub && formNpub === npub;

  // A stored npub with no identity yet is a restore in flight, not a signed-out visitor.
  useEffect(() => {
    setMounted(true);
    const timer = setTimeout(() => setGaveUp(true), 8000);
    return () => clearTimeout(timer);
  }, []);
  const restoring = mounted && !identity && !gaveUp && !!storage.npub.get();

  // ---- load: the saved draft, or the stored playlist in edit mode ----------
  useEffect(() => {
    // An account switch: nothing of the last account's form survives.
    setFormNpub(null); setTitle(''); setDescription(''); setArtUrl(''); setSongs([]); setLabels({});
    setEditingId(null); setExpectedUpdatedAt(null); setDirty(false); setUnsaved(false); setRefusals([]);
    setNote(null); setLoadError(null); setDeleted(null); setPublished(null); setConfirmDelete(false);
    if (!npub) return;
    let live = true;
    const id = new URLSearchParams(window.location.search).get('id');
    const apply = (c: PlaylistDraftCache) => {
      setTitle(c.draft.title); setDescription(c.draft.description); setArtUrl(c.draft.artUrl ?? '');
      setSongs(c.draft.songs); setLabels(c.labels); setEditingId(c.editingId); setExpectedUpdatedAt(c.expectedUpdatedAt);
    };
    (async () => {
      if (!id) {
        const cached = storage.playlistDraft.get(npub);
        if (cached) apply(cached);
        setFormNpub(npub);
        return;
      }
      const cached = storage.playlistDraft.get(npub, id);
      const p = await fetchPlaylist(id);
      if (!live) return;
      if (!p) { setLoadError('We could not load that playlist.'); setFormNpub(npub); return; }
      if (p.ownerPubkey !== pubkey) { setLoadError('Only the person who made this playlist can edit it.'); setFormNpub(npub); return; }
      // A restored draft keeps the version it was MADE against. If the playlist changed
      // elsewhere since, SAVE then gets the 409 "changed elsewhere" warning; taking the
      // server's version here would overwrite that change with no word.
      if (cached) apply({ ...cached, editingId: id, expectedUpdatedAt: cached.expectedUpdatedAt ?? p.updatedAt });
      else {
        setTitle(p.title); setDescription(p.description); setArtUrl(p.artUrl ?? '');
        setSongs(p.songs); setEditingId(p.id); setExpectedUpdatedAt(p.updatedAt);
      }
      setFormNpub(npub);
      if (cached && Object.keys(cached.labels).length) return;
      // Titles for the rows: the app's own resolver, one page of RESOLVE_PAGE at a time.
      const l: Labels = {};
      try {
        let offset: number | null = 0;
        while (offset !== null && live) {
          const r: Response = await fetch(`/api/playlist?url=${encodeURIComponent(communityFeedUrl(p.id))}&limit=${RESOLVE_PAGE}&offset=${offset}`);
          const j = r.ok ? await r.json() : null;
          if (!j) break;
          for (const e of (j.episodes ?? []) as Array<{ guid?: string; title?: string; feedTitle?: string; image?: string; feedImage?: string; unresolved?: boolean }>) {
            if (e.guid && e.title && !e.unresolved) {
              l[e.guid] = { title: e.title, ...(e.feedTitle ? { artist: e.feedTitle } : {}), ...((e.image || e.feedImage) ? { image: e.image || e.feedImage } : {}) };
            }
          }
          offset = typeof j.nextOffset === 'number' ? j.nextOffset : null;
        }
      } catch { /* rows keep a plain name */ }
      if (live) setLabels(l);
    })();
    return () => { live = false; };
  }, [npub, pubkey]);

  // ---- save the draft after a user change ----------------------------------
  useEffect(() => {
    if (!npub || !ready || !dirty || published || deleted || loadError) return;
    const ok = storage.playlistDraft.set(npub, {
      draft: { title, description, artUrl: artUrl.trim() === '' ? null : artUrl, songs },
      editingId, expectedUpdatedAt, labels,
    }, editingId ?? undefined);
    setUnsaved(!ok);
  }, [npub, ready, dirty, published, deleted, loadError, title, description, artUrl, songs, labels, editingId, expectedUpdatedAt]);

  const draft: PlaylistDraft = useMemo(
    () => ({ title, description, artUrl: artUrl.trim() === '' ? null : artUrl.trim(), songs }),
    [title, description, artUrl, songs],
  );
  const blocked = whyNot(draft);
  const cleaned = cleanText(title);
  const cleanedDesc = cleanText(description);

  const edit = <T,>(set: (v: T) => void) => (v: T) => { setDirty(true); set(v); };
  const move = (i: number, by: -1 | 1) => { setDirty(true); setSongs((s) => {
    const j = i + by;
    if (j < 0 || j >= s.length) return s;
    const n = s.slice(); [n[i], n[j]] = [n[j], n[i]]; return n;
  }); };
  const remove = (i: number) => { setDirty(true); setSongs((s) => s.filter((_, k) => k !== i)); };

  const failure = (e: unknown) => (e instanceof SignTimeoutError || e instanceof NoSignerError
    ? (e instanceof NoSignerError ? e.message : 'Your signer did not answer. Open it and try again.')
    : 'Could not reach the server. Try again.');

  const submit = useCallback(async () => {
    const v = validatePlaylistDraft(draft, textHoldsSecret);
    if (!v.ok || !npub || !pubkey) return;
    setBusy(true); setNote(null); setRefusals([]);
    try {
      let res: Response;
      if (editingId) {
        // An edit never POSTs. A missing `expectedUpdatedAt` is read from the server first.
        let expected = expectedUpdatedAt;
        if (!expected) {
          expected = (await fetchPlaylist(editingId))?.updatedAt ?? null;
          if (!expected) { setNote('We could not read the playlist. Try again.'); return; }
          setExpectedUpdatedAt(expected);
        }
        res = await savePlaylist(editingId, v.draft, expected);
      } else {
        res = await publishPlaylist(v.draft);
      }
      const body = await res.json().catch(() => null) as
        { id?: string; feedUrl?: string; error?: string; problems?: Refusal[]; playlist?: { id: string; updatedAt: string } } | null;
      if (res.ok) {
        const id = body?.id ?? body?.playlist?.id ?? editingId;
        if (!id) { setNote('Something went wrong. Try again.'); return; }
        storage.playlistDraft.clear(npub, editingId ?? undefined);
        setDirty(false); setUnsaved(false);
        const list = await fetchCommunityPlaylists(pubkey);
        const summary = list?.find((p) => p.id === id) ?? null;
        setEditingId(id);
        setExpectedUpdatedAt(summary?.updatedAt ?? body?.playlist?.updatedAt ?? null);
        setPublished({ id, feedUrl: body?.feedUrl ?? communityFeedUrl(id), title: cleanText(v.draft.title), tracks: v.draft.songs.length, summary });
        return;
      }
      if (res.status === 400 && Array.isArray(body?.problems)) setRefusals(body.problems);
      // The route's body cap (MAX_PLAYLIST_BODY_BYTES): a retry sends the same bytes.
      else if (res.status === 400 && body?.error === 'payload too large') {
        setNote('This playlist is too large to save. Remove some songs and try again.');
      } else if (res.status === 409 && editingId) {
        // Changed elsewhere: keep the user's form, take the new version number.
        const cur = await fetchPlaylist(editingId);
        if (cur) setExpectedUpdatedAt(cur.updatedAt);
        setNote('This playlist changed elsewhere. Your edits are kept; SAVE again to overwrite.');
      } else if (res.status === 410) {
        storage.playlistDraft.clear(npub, editingId ?? undefined);
        setDirty(false); setDeleted('gone');
      } else if (res.status === 401) setNote('Your sign-in was refused. Sign in again.');
      else if (res.status === 403 || res.status === 503) setNote(body?.error ? `The server said: ${body.error}.` : 'The server refused this.');
      else if (res.status === 429) setNote('Too many changes. Wait a minute and try again.');
      else setNote('Could not save the playlist. Try again.');
    } catch (e) {
      setNote(failure(e));
    } finally {
      setBusy(false);
    }
  }, [draft, npub, pubkey, editingId, expectedUpdatedAt]);

  async function remove_() {
    if (!editingId || !npub) return;
    setConfirmDelete(false); setBusy(true); setNote(null);
    try {
      const res = await deleteOwnPlaylist(editingId);
      // 410: already deleted, which is what was asked for.
      if (res.ok || res.status === 410) { storage.playlistDraft.clear(npub, editingId); setDirty(false); setDeleted('deleted'); }
      else setNote('Could not delete the playlist. Try again.');
    } catch (e) {
      setNote(failure(e));
    } finally { setBusy(false); }
  }

  // ---- screens ---------------------------------------------------------------
  if (!COMMUNITY_PLAYLISTS_ON) return null;

  if (!identity && restoring) {
    return (
      <section>
        <h1 className="headline text-3xl sm:text-4xl">new playlist</h1>
        <p className="mt-3 text-sm text-muted" role="status">Signing in…</p>
      </section>
    );
  }

  if (!identity) {
    return (
      <section>
        <h1 className="headline text-3xl sm:text-4xl">new playlist</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-bone/80">Sign in to make a playlist.</p>
        <button type="button" className="btn-bolt btn-compact mt-4" onClick={() => setSignInOpen(true)}>SIGN IN</button>
      </section>
    );
  }

  if (!ready) {
    return (
      <section>
        <h1 className="headline text-3xl sm:text-4xl">new playlist</h1>
        <p className="mt-3 text-sm text-muted" role="status">Loading…</p>
      </section>
    );
  }

  if (deleted) {
    return (
      <section>
        <h1 className="headline text-3xl sm:text-4xl">playlist deleted</h1>
        <p className="mt-3 text-sm text-bone/80">
          {deleted === 'gone' ? 'This playlist was deleted.' : 'The playlist is gone.'} Its feed address no longer works.
        </p>
        <Link href="/playlists" className="btn-ghost btn-compact mt-4 inline-flex">♫ BROWSE PLAYLISTS</Link>
      </section>
    );
  }

  if (published) {
    return (
      <PlaylistPublished
        feedUrl={published.feedUrl}
        title={published.title}
        byName={name}
        tracks={published.tracks}
        summary={published.summary}
        onEdit={() => {
          setPublished(null);
          window.history.replaceState(null, '', `/playlists/make?id=${published.id}`);
        }}
      />
    );
  }

  if (loadError) {
    return (
      <section>
        <h1 className="headline text-3xl sm:text-4xl">edit playlist</h1>
        <p role="alert" className="mt-3 text-sm text-bone/80">{loadError}</p>
        <Link href="/playlists/make" className="btn-ghost btn-compact mt-4 inline-flex">+ MAKE A NEW PLAYLIST</Link>
      </section>
    );
  }

  const art = draft.artUrl && /^https:\/\//i.test(draft.artUrl) ? draft.artUrl : null;
  const grid = songs.slice(0, 4).map((s) => labels[s.itemGuid]?.image ?? null);

  return (
    <section aria-labelledby="maker-heading">
      <h1 id="maker-heading" className="headline text-3xl sm:text-4xl">{editingId ? 'edit playlist' : 'new playlist'}</h1>

      <div className="mt-4 h-32 w-32 border border-bone/30 bg-ink/40" aria-hidden data-testid="cover-preview">
        {art ? (
          <RowThumb src={artCandidates(art, null, 320)[0]} fallback={art} className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full w-full grid-cols-2 grid-rows-2">
            {[0, 1, 2, 3].map((k) => (grid[k]
              ? <RowThumb key={k} src={artCandidates(grid[k], null, 160)[0]} fallback={grid[k]!} className="h-full w-full object-cover" />
              : <div key={k} className="bg-bone/10" />))}
          </div>
        )}
      </div>

      <div className="mt-5 max-w-xl space-y-4">
        <div>
          <label htmlFor="pl-title" className="block text-xs font-mono uppercase tracking-wider text-muted">TITLE</label>
          <input id="pl-title" className="input mt-1" value={title} maxLength={MAX_TITLE_LEN} onChange={(e) => edit(setTitle)(e.target.value)} />
          {title && cleaned !== title && (
            <p className="mt-1 text-xs text-muted">Will publish as: {cleaned}</p>
          )}
        </div>
        <div>
          <label htmlFor="pl-desc" className="block text-xs font-mono uppercase tracking-wider text-muted">DESCRIPTION</label>
          <textarea id="pl-desc" className="input mt-1" rows={3} value={description} onChange={(e) => edit(setDescription)(e.target.value)} />
          {description && cleanedDesc !== description && (
            <p className="mt-1 text-xs text-muted">Will publish as: {cleanedDesc}</p>
          )}
        </div>
        <div>
          <label htmlFor="pl-art" className="block text-xs font-mono uppercase tracking-wider text-muted">PLAYLIST ART LINK</label>
          <input id="pl-art" className="input mt-1" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
            aria-describedby="pl-art-hint" value={artUrl} onChange={(e) => edit(setArtUrl)(e.target.value)} />
          <p id="pl-art-hint" className="mt-1 text-xs text-muted">
            Square, 1400–3000 px. Empty: BMB makes the cover from the first four songs.
          </p>
        </div>
      </div>

      <div className="mt-6 max-w-xl border border-bone/15 bg-ink/90 px-3" data-songs-panel>
      <ol className="divide-y divide-bone/15" aria-label="Songs">
        {songs.map((s, i) => {
          const l = labels[s.itemGuid];
          return (
            <li key={`${s.feedGuid}:${s.itemGuid}`} className="flex flex-wrap items-center gap-2 py-2" data-song-row>
              {/* The track number is the row's place in the playlist, so it follows a move. */}
              <span className="w-6 shrink-0 text-right font-mono text-xs tabular-nums text-muted" data-song-number>{i + 1}</span>
              {/* The song's own cover, through /api/art with the raw URL behind it
                  (CLAUDE.md: artwork goes through /api/art). An unknown cover keeps
                  the same box, so the rows stay aligned. */}
              <SongPreviewButton feedGuid={s.feedGuid} itemGuid={s.itemGuid} title={l?.title ?? 'Song'} image={l?.image} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-bone">{l?.title ?? 'Song'}</p>
                {l?.artist && <p className="truncate text-xs text-bone/70">{l.artist}</p>}
              </div>
              <button type="button" className={ICON_BTN} aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" className={ICON_BTN} aria-label="Move down" disabled={i === songs.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button type="button" className={ICON_BTN} aria-label="Remove" onClick={() => remove(i)}>×</button>
            </li>
          );
        })}
      </ol>
      <p className="border-t border-bone/15 py-2 text-xs text-bone/70">{songs.length} {songs.length === 1 ? 'song' : 'songs'}</p>
      </div>
      <button type="button" className="btn-ghost btn-compact mt-3" aria-expanded={addOpen} onClick={() => setAddOpen(true)}>+ ADD SONGS</button>

      {(refusals.length > 0 || note) && (
        <div role="alert" className="mt-4 max-w-xl border border-bone/30 p-3 text-sm" data-testid="refusals">
          {refusals.map((p, i) => <p key={i}>{problemText(p, labels)}</p>)}
          {note && <p>{note}</p>}
        </div>
      )}

      {/* In normal flow, not pinned: a bar pinned to the dock sits under the mini-player. */}
      <div className="mt-6 max-w-xl border-t border-bone/15 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-bolt btn-compact" disabled={!!blocked || busy} onClick={submit}>
            {busy ? '…' : editingId ? 'SAVE' : 'PUBLISH'}
          </button>
          {editingId && (
            <button type="button" className="btn-ghost btn-compact" disabled={busy} onClick={() => setConfirmDelete(true)}>DELETE</button>
          )}
          {blocked && <span className="text-xs text-muted" data-testid="why-blocked">{blocked}</span>}
        </div>
        <p className="mt-2 text-xs text-muted">Signed in as {name}. Only you can change this playlist.</p>
        {unsaved && <p className="mt-1 text-xs text-muted" data-testid="unsaved">This draft is not being saved on this device.</p>}
      </div>

      {addOpen && (
        <AddSongsSheet
          songs={songs}
          playlistTitle={title}
          onClose={() => setAddOpen(false)}
          onAdd={(song, label) => {
            setDirty(true);
            setSongs((s) => (s.some((x) => x.feedGuid === song.feedGuid && x.itemGuid === song.itemGuid) ? s : [...s, song]));
            setLabels((l) => ({ ...l, [song.itemGuid]: label }));
          }}
        />
      )}

      {confirmDelete && (
        <ModalShell onClose={() => setConfirmDelete(false)} label="Delete this playlist" className="w-full max-w-sm" closeButton>
          <div className="p-5">
            <h2 className="font-display text-xl">Delete this playlist?</h2>
            <p className="mt-2 text-sm text-bone/80">Its feed address stops working. This cannot be undone.</p>
            <div className="mt-4 flex gap-2">
              <button type="button" className="btn-ghost btn-compact" onClick={() => setConfirmDelete(false)}>CANCEL</button>
              <button type="button" className="btn-bolt btn-compact" onClick={remove_}>DELETE</button>
            </div>
          </div>
        </ModalShell>
      )}
    </section>
  );
}
