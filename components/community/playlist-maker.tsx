'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { ModalShell } from '@/components/modal-shell';
import { cleanText } from '@/lib/community/clean-text';
import {
  MIN_SONGS, validatePlaylistDraft,
  type ArtRefusal, type CommunityPlaylistSummary, type DraftProblem, type PlaylistDraft, type PlaylistSong,
} from '@/lib/community/rules';
import {
  SignTimeoutError, deleteOwnPlaylist, fetchCommunityPlaylists, fetchPlaylist, publishPlaylist, savePlaylist,
} from '@/lib/community/client';
import { COMMUNITY_PLAYLISTS_ON, communityFeedUrl } from '@/lib/curated-playlists';
import { PlaylistPublished } from './playlist-published';

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
    case 'art': return ART_WORDS[p.reason] ?? ART_WORDS['not-image'];
    case 'song-not-found': return `${song(p.itemGuid)} was not found. Remove it and try again.`;
    case 'not-music': return `${song(p.itemGuid)} is not a music track. Remove it and try again.`;
  }
}

/** Why PUBLISH is off, in one short line; null when it is on. */
function whyNot(d: PlaylistDraft): string | null {
  const v = validatePlaylistDraft(d);
  if (v.ok) return null;
  const order: DraftProblem['kind'][] = ['too-few-songs', 'title-missing'];
  const first = order.map((k) => v.problems.find((p) => p.kind === k)).find(Boolean) ?? v.problems[0];
  return problemText(first, {}).replace(/\.$/, '');
}

const ICON_BTN = 'inline-flex h-8 w-8 items-center justify-center border border-bone/30 text-bone/80 hover:border-bone/60 hover:text-bone disabled:opacity-30';

export function PlaylistMaker() {
  const identity = useApp((s) => s.identity);
  const setSignInOpen = useApp((s) => s.setSignInOpen);

  const [ready, setReady] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [artUrl, setArtUrl] = useState('');
  const [songs, setSongs] = useState<PlaylistSong[]>([]);
  const [labels, setLabels] = useState<Labels>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState<string | null>(null);
  // The flag Task 10's <AddSongsSheet> reads. Nothing in the UI adds a song until it exists.
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusals, setRefusals] = useState<Refusal[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [published, setPublished] = useState<{
    id: string; feedUrl: string; title: string; tracks: number; summary: CommunityPlaylistSummary | null;
  } | null>(null);

  const npub = identity?.npub ?? null;
  const pubkey = identity?.pubkey ?? null;
  const name = identity?.profile?.display_name || identity?.profile?.name || (npub ? `${npub.slice(0, 12)}…` : '');

  // ---- load: the saved draft, or the stored playlist in edit mode ----------
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!npub || loadedFor.current === npub) return;
    loadedFor.current = npub;
    let live = true;
    const id = new URLSearchParams(window.location.search).get('id');
    const cached = storage.playlistDraft.get(npub);
    const apply = (c: NonNullable<typeof cached>) => {
      setTitle(c.draft.title); setDescription(c.draft.description); setArtUrl(c.draft.artUrl ?? '');
      setSongs(c.draft.songs); setLabels(c.labels); setEditingId(c.editingId); setExpectedUpdatedAt(c.expectedUpdatedAt);
    };
    (async () => {
      if (id && cached?.editingId !== id) {
        const p = await fetchPlaylist(id);
        if (!live) return;
        if (!p) { setLoadError('We could not load that playlist.'); setReady(true); return; }
        if (p.ownerPubkey !== pubkey) { setLoadError('Only the person who made this playlist can edit it.'); setReady(true); return; }
        setTitle(p.title); setDescription(p.description); setArtUrl(p.artUrl ?? '');
        setSongs(p.songs); setEditingId(p.id); setExpectedUpdatedAt(p.updatedAt);
        setReady(true);
        // Titles for the rows: one read of the playlist through the app's own resolver.
        try {
          const r = await fetch(`/api/playlist?url=${encodeURIComponent(communityFeedUrl(p.id))}&limit=500`);
          const j = r.ok ? await r.json() : null;
          const l: Labels = {};
          for (const e of (j?.episodes ?? []) as Array<{ guid?: string; title?: string; feedTitle?: string; image?: string; feedImage?: string; unresolved?: boolean }>) {
            if (e.guid && e.title && !e.unresolved) {
              l[e.guid] = { title: e.title, ...(e.feedTitle ? { artist: e.feedTitle } : {}), ...((e.image || e.feedImage) ? { image: e.image || e.feedImage } : {}) };
            }
          }
          if (live) setLabels(l);
        } catch { /* rows keep a plain name */ }
        return;
      }
      if (cached && (id ? cached.editingId === id : cached.editingId === null)) apply(cached);
      setReady(true);
    })();
    return () => { live = false; loadedFor.current = null; };
  }, [npub, pubkey]);

  // ---- save the draft on every change --------------------------------------
  useEffect(() => {
    if (!npub || !ready || published || deleted || loadError) return;
    storage.playlistDraft.set(npub, {
      draft: { title, description, artUrl: artUrl.trim() === '' ? null : artUrl, songs },
      editingId, expectedUpdatedAt, labels,
    });
  }, [npub, ready, published, deleted, loadError, title, description, artUrl, songs, labels, editingId, expectedUpdatedAt]);

  const draft: PlaylistDraft = useMemo(
    () => ({ title, description, artUrl: artUrl.trim() === '' ? null : artUrl.trim(), songs }),
    [title, description, artUrl, songs],
  );
  const blocked = whyNot(draft);
  const cleaned = cleanText(title);

  const move = (i: number, by: -1 | 1) => setSongs((s) => {
    const j = i + by;
    if (j < 0 || j >= s.length) return s;
    const n = s.slice(); [n[i], n[j]] = [n[j], n[i]]; return n;
  });
  const remove = (i: number) => setSongs((s) => s.filter((_, k) => k !== i));

  const submit = useCallback(async () => {
    const v = validatePlaylistDraft(draft);
    if (!v.ok || !npub || !pubkey) return;
    setBusy(true); setNote(null); setRefusals([]);
    try {
      const res = editingId && expectedUpdatedAt
        ? await savePlaylist(editingId, v.draft, expectedUpdatedAt)
        : await publishPlaylist(v.draft);
      const body = await res.json().catch(() => null) as
        { id?: string; feedUrl?: string; problems?: Refusal[]; playlist?: { id: string; updatedAt: string } } | null;
      if (res.ok) {
        const id = body?.id ?? body?.playlist?.id ?? editingId;
        if (!id) { setNote('Something went wrong. Try again.'); return; }
        storage.playlistDraft.clear(npub);
        const list = await fetchCommunityPlaylists(pubkey);
        const summary = list?.find((p) => p.id === id) ?? null;
        setEditingId(id);
        setExpectedUpdatedAt(summary?.updatedAt ?? body?.playlist?.updatedAt ?? null);
        setPublished({ id, feedUrl: body?.feedUrl ?? communityFeedUrl(id), title: cleanText(v.draft.title), tracks: v.draft.songs.length, summary });
        return;
      }
      if (res.status === 400 && Array.isArray(body?.problems)) setRefusals(body.problems);
      else if (res.status === 409) setNote('This playlist was changed somewhere else. Reload the page to see the new version.');
      else if (res.status === 401) setNote('Your sign-in was refused. Sign in again.');
      else if (res.status === 403) setNote('This account cannot change this playlist.');
      else if (res.status === 410) setNote('This playlist was deleted.');
      else if (res.status === 429) setNote('Too many changes. Wait a minute and try again.');
      else setNote('Could not save the playlist. Try again.');
    } catch (e) {
      setNote(e instanceof SignTimeoutError
        ? 'Your signer did not answer. Open it and try again.'
        : 'Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  }, [draft, npub, pubkey, editingId, expectedUpdatedAt]);

  async function remove_() {
    if (!editingId || !npub) return;
    setConfirmDelete(false); setBusy(true); setNote(null);
    try {
      const res = await deleteOwnPlaylist(editingId);
      if (res.ok) { storage.playlistDraft.clear(npub); setDeleted(true); }
      else setNote('Could not delete the playlist. Try again.');
    } catch (e) {
      setNote(e instanceof SignTimeoutError ? 'Your signer did not answer. Open it and try again.' : 'Could not reach the server. Try again.');
    } finally { setBusy(false); }
  }

  // ---- screens ---------------------------------------------------------------
  if (!COMMUNITY_PLAYLISTS_ON) return null;

  if (!identity) {
    return (
      <section>
        <h1 className="headline text-3xl sm:text-4xl">new playlist</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-bone/80">Sign in to make a playlist.</p>
        <button type="button" className="btn-bolt btn-compact mt-4" onClick={() => setSignInOpen(true)}>SIGN IN</button>
      </section>
    );
  }

  if (deleted) {
    return (
      <section>
        <h1 className="headline text-3xl sm:text-4xl">playlist deleted</h1>
        <p className="mt-3 text-sm text-bone/80">The playlist is gone. Its feed address no longer works.</p>
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
          // eslint-disable-next-line @next/next/no-img-element
          <img src={art} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
        ) : (
          <div className="grid h-full w-full grid-cols-2 grid-rows-2">
            {[0, 1, 2, 3].map((k) => (grid[k]
              // eslint-disable-next-line @next/next/no-img-element
              ? <img key={k} src={grid[k]!} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
              : <div key={k} className="bg-bone/10" />))}
          </div>
        )}
      </div>

      <div className="mt-5 max-w-xl space-y-4">
        <div>
          <label htmlFor="pl-title" className="block text-xs font-mono uppercase tracking-wider text-muted">TITLE</label>
          <input id="pl-title" className="input mt-1" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          {title && cleaned !== title && (
            <p className="mt-1 text-xs text-muted">Will publish as: {cleaned}</p>
          )}
        </div>
        <div>
          <label htmlFor="pl-desc" className="block text-xs font-mono uppercase tracking-wider text-muted">DESCRIPTION</label>
          <textarea id="pl-desc" className="input mt-1" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <label htmlFor="pl-art" className="block text-xs font-mono uppercase tracking-wider text-muted">PLAYLIST ART LINK</label>
          <input id="pl-art" className="input mt-1" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
            aria-describedby="pl-art-hint" value={artUrl} onChange={(e) => setArtUrl(e.target.value)} />
          <p id="pl-art-hint" className="mt-1 text-xs text-muted">
            Square, 1400–3000 px. Empty: BMB makes the cover from the first four songs.
          </p>
        </div>
      </div>

      <ol className="mt-6 max-w-xl divide-y divide-bone/15 border-y border-bone/15" aria-label="Songs">
        {songs.map((s, i) => {
          const l = labels[s.itemGuid];
          return (
            <li key={`${s.feedGuid}:${s.itemGuid}`} className="flex items-center gap-2 py-2" data-song-row>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{l?.title ?? 'Song'}</p>
                {l?.artist && <p className="truncate text-xs text-muted">{l.artist}</p>}
              </div>
              <button type="button" className={ICON_BTN} aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" className={ICON_BTN} aria-label="Move down" disabled={i === songs.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button type="button" className={ICON_BTN} aria-label="Remove" onClick={() => remove(i)}>×</button>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-xs text-muted">{songs.length} {songs.length === 1 ? 'song' : 'songs'}</p>
      <button type="button" className="btn-ghost btn-compact mt-3" aria-expanded={addOpen} onClick={() => setAddOpen(true)}>+ ADD SONGS</button>

      {(refusals.length > 0 || note) && (
        <div role="alert" className="mt-4 max-w-xl border border-bone/30 p-3 text-sm" data-testid="refusals">
          {refusals.map((p, i) => <p key={i}>{problemText(p, labels)}</p>)}
          {note && <p>{note}</p>}
        </div>
      )}

      <div className="sticky z-20 mt-6 max-w-xl border-t border-bone/15 bg-ink py-3" style={{ bottom: 'var(--dock-b, 0px)' }}>
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
      </div>

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
