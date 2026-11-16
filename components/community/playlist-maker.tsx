'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useApp } from '@/lib/store';
import { storage, type PlaylistDraftCache } from '@/lib/storage';
import { ModalShell } from '@/components/modal-shell';
import { RowThumb } from '@/components/chapter-ui';
import { artCandidates, mapLimit } from '@/lib/util';
import { whyNotPlayable, type SongKnown } from './song-check';
import { SongPreviewButton } from '@/components/community/song-preview-button';
import { cleanText } from '@/lib/community/clean-text';
import {
  ART_MIN_PX, MAX_TITLE_LEN, artUploadServers, MIN_SONGS, validatePlaylistDraft,
  type ArtRefusal, type CommunityPlaylistSummary, type DraftProblem, type PlaylistDraft, type PlaylistSong,
} from '@/lib/community/rules';
import {
  NoSignerError, SignFailedError, SignTimeoutError, deleteOwnPlaylist, fetchCommunityPlaylists, fetchPlaylist, publishPlaylist, savePlaylist,
} from '@/lib/community/client';
import { ArtUploadError, fetchBlossomServers, uploadPlaylistArt, type ArtUploadFailure } from '@/lib/community/blossom';
import { COMMUNITY_PLAYLISTS_ON, communityFeedUrl } from '@/lib/curated-playlists';
import { textHoldsSecret } from '@/lib/nostr/npub-input';
import { PlaylistPublished } from './playlist-published';
import { AddSongsSheet } from './add-songs-sheet';
import { PublishChecklist } from './publish-checklist';

// The resolver's page size (`MAX_BATCH` in lib/pi-batch.ts, which is server-only and cannot be imported here).
const RESOLVE_PAGE = 100;

/**
 * How many songs the EDIT view checks for a dead file per load. Each check is
 * one `/api/audio-probe`, which allows 120 a minute per address; a check the
 * route refuses counts as "could not ask" and marks nothing, so a long playlist
 * is never marked wrongly, only partly.
 */
const MAX_EDIT_CHECKS = 200;

type Labels = Record<string, { title: string; artist?: string; image?: string }>;

/** A server refusal, per problem. */
type Refusal =
  | DraftProblem
  | { kind: 'art'; reason: ArtRefusal }
  | { kind: 'song-not-found'; itemGuid: string }
  | { kind: 'not-music'; itemGuid: string }
  | { kind: 'song-gone'; itemGuid: string; service: string };

const ART_WORDS: Record<ArtRefusal, string> = {
  'too-small': `The picture must be at least ${ART_MIN_PX} px on its shortest side.`,
  format: 'Use a PNG or JPEG picture.',
  'not-image': 'That link is not a picture we can read.',
};

const UPLOAD_WORDS: Record<ArtUploadFailure, string> = {
  'not-image': 'That file is not a picture we can read. Use a JPEG or PNG.',
  'too-small': `The picture must be at least ${ART_MIN_PX} px on its shortest side.`,
  refused: 'The picture host refused the upload. Try again, or paste a link.',
  network: 'The upload did not finish. Check your connection and try again.',
  'bad-answer': 'The picture host gave an answer we cannot use. Try again, or paste a link.',
};

function problemText(p: Refusal, labels: Labels): string {
  const song = (guid: string) => labels[guid]?.title ?? 'A song';
  switch (p.kind) {
    case 'title-missing': return 'Add a title.';
    case 'title-too-long': return 'The title is too long.';
    case 'description-too-long': return 'The description is too long.';
    case 'name-too-long': return 'The name is too long.';
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
    case 'song-gone': return `${song(p.itemGuid)} cannot play: its host (${p.service}) closed. Remove it and try again.`;
  }
}

/**
 * What PUBLISH still needs, in one short line beside it; null when it can send.
 * A secret key in the title or description comes first: it must be removed
 * before anything is sent. The sign-in comes last, because the draft can be
 * finished signed out. The full list is <PublishChecklist>, opened by a press.
 */
function whyNot(v: ReturnType<typeof validatePlaylistDraft>, signedIn: boolean): string | null {
  if (v.ok) return signedIn ? null : 'Sign in with Nostr to publish';
  const order: DraftProblem['kind'][] = ['secret', 'too-few-songs', 'title-missing'];
  const first = order.map((k) => v.problems.find((p) => p.kind === k)).find(Boolean) ?? v.problems[0];
  return problemText(first, {}).replace(/\.$/, '');
}

/** A new-playlist draft with anything in it: only such a draft moves to the account at sign-in. */
const hasWork = (d: PlaylistDraft) => !!(d.title.trim() || d.description.trim() || d.artUrl || d.songs.length);

/** The form's owner while signed out. Never an npub, so it cannot match one. */
const GUEST = ':guest';

const ICON_BTN = 'inline-flex h-8 w-8 items-center justify-center border border-bone/30 text-bone/80 hover:border-bone/60 hover:text-bone disabled:opacity-30';

export function PlaylistMaker() {
  const identity = useApp((s) => s.identity);
  const setSignInOpen = useApp((s) => s.setSignInOpen);

  // Who the form on screen belongs to: an npub, or GUEST signed out. A draft is written
  // only while this equals the current owner, so one account's form is never saved under
  // another's key. The one crossing is deliberate: a GUEST draft MOVES to the account
  // that signs in (the load effect below).
  const [formOwner, setFormOwner] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  // The NAME box: who made the playlist, printed as the feed's author. Typed, never
  // read from the Nostr profile (Chad, 2026-11-16).
  const [ownerName, setOwnerName] = useState('');
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
  // The UPLOAD button: in flight, and the one line under the art field.
  const [uploading, setUploading] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const artFileRef = useRef<HTMLInputElement>(null);
  // Bumped on every account switch, so an upload that finishes after one never
  // writes its link into the next account's form.
  const formGen = useRef(0);
  // The EDIT view's dead-song warning. `known` holds what the row load learned
  // about each song (its file, Podcast Index's "not found"), so the check asks
  // nothing twice; `checked` is every song already asked about, so a move or a
  // remove does not ask again; `dead` is the answer.
  const known = useRef<Record<string, SongKnown>>({});
  const checked = useRef<Set<string>>(new Set());
  const [dead, setDead] = useState<Record<string, true>>({});
  const [checkReady, setCheckReady] = useState(false);
  // The signed-in user's own Blossom servers (kind:10063). `null` while the read
  // is in flight; the promise is kept so an UPLOAD pressed before it lands waits for it.
  const [userServers, setUserServers] = useState<string[] | null>(null);
  const serversRead = useRef<Promise<string[]> | null>(null);
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
  // <PublishChecklist>: PUBLISH pressed while something is missing.
  const [checkOpen, setCheckOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  // Signed out on `?id=`: editing a stored playlist needs its owner, so the page asks for a sign-in.
  const [editNeedsSignIn, setEditNeedsSignIn] = useState(false);
  // Said once, when the draft made signed out replaced an older unsent one of this account.
  const [carryNote, setCarryNote] = useState<string | null>(null);
  // The signed-out form as last written, for the sign-in that follows. The `:guest`
  // slot on disk covers a sign-in that leaves the page (Amber); this copy covers a
  // write the disk refused, which the slot alone would lose.
  const guestWork = useRef<PlaylistDraftCache | null>(null);

  const npub = identity?.npub ?? null;
  const pubkey = identity?.pubkey ?? null;
  const name = identity?.profile?.display_name || identity?.profile?.name || (npub ? `${npub.slice(0, 12)}…` : '');
  const owner = npub ?? GUEST;
  const ready = formOwner === owner;

  // A stored npub with no identity yet is a restore in flight, not a signed-out visitor.
  useEffect(() => {
    setMounted(true);
    const timer = setTimeout(() => setGaveUp(true), 8000);
    return () => clearTimeout(timer);
  }, []);
  const restoring = mounted && !identity && !gaveUp && !!storage.npub.get();
  // No MADE BY box on this branch, so nothing else clears the name: an account switch
  // must not carry one account's name into the next one's draft. Runs before the load
  // effect below, which sets the loaded name. #576's load effect clears it itself, so
  // this goes when #576 lands.
  useEffect(() => { setOwnerName(''); }, [npub]);

  // ---- load: the saved draft, or the stored playlist in edit mode ----------
  useEffect(() => {
    // An account switch: nothing of the last account's form survives.
    setFormOwner(null); setTitle(''); setDescription(''); setArtUrl(''); setSongs([]); setLabels({});
    setEditingId(null); setExpectedUpdatedAt(null); setDirty(false); setUnsaved(false); setRefusals([]);
    setNote(null); setLoadError(null); setDeleted(null); setPublished(null); setConfirmDelete(false);
    setUploadNote(null); setUploading(false); formGen.current += 1;
    setCheckOpen(false); setEditNeedsSignIn(false); setCarryNote(null);
    known.current = {}; checked.current = new Set(); setDead({}); setCheckReady(false);
    const id = new URLSearchParams(window.location.search).get('id');
    const apply = (c: PlaylistDraftCache) => {
      setTitle(c.draft.title); setDescription(c.draft.description); setOwnerName(c.draft.ownerName); setArtUrl(c.draft.artUrl ?? '');
      setSongs(c.draft.songs); setLabels(c.labels); setEditingId(c.editingId); setExpectedUpdatedAt(c.expectedUpdatedAt);
    };
    if (!npub) {
      // Signed out the form works on the `:guest` slot, so a visitor can build the
      // playlist first and sign in at PUBLISH (Chad, 2026-11-15). Editing a stored
      // playlist is its owner's alone.
      if (id) { setEditNeedsSignIn(true); return; }
      const cached = storage.playlistDraft.get(null);
      if (cached) apply({ ...cached, editingId: null, expectedUpdatedAt: null });
      setFormOwner(GUEST);
      return;
    }
    let live = true;
    (async () => {
      if (!id) {
        // The draft made signed out MOVES to this account, as the listen queue's
        // `:guest` copy does: left under `:guest`, the next account to sign in on
        // this device would take it again. Cleared only once the account's copy
        // LANDED, so a refused write never loses it from both places. An Amber
        // sign-in reloads the page, so this cannot tell a sign-in from a restore;
        // it moves at the first signed-in load either way.
        const work = guestWork.current ?? storage.playlistDraft.get(null);
        guestWork.current = null;
        const own = storage.playlistDraft.get(npub);
        if (work && hasWork(work.draft)) {
          const moved: PlaylistDraftCache = { ...work, editingId: null, expectedUpdatedAt: null };
          apply(moved);
          const landed = storage.playlistDraft.set(npub, moved);
          if (landed) storage.playlistDraft.clear(null);
          setUnsaved(!landed);
          // The work just done wins over an older unsent draft, and says so.
          if (own && hasWork(own.draft) && JSON.stringify(own.draft) !== JSON.stringify(moved.draft)) {
            setCarryNote('This is the playlist you made before you signed in. It replaced an older unsent draft on this device.');
          }
        } else {
          // An emptied form leaves an empty `:guest` slot: nothing to move, so nothing to keep.
          if (work) storage.playlistDraft.clear(null);
          if (own) apply(own);
        }
        setFormOwner(npub);
        return;
      }
      const cached = storage.playlistDraft.get(npub, id);
      const p = await fetchPlaylist(id);
      if (!live) return;
      if (!p) { setLoadError('We could not load that playlist.'); setFormOwner(npub); return; }
      if (p.ownerPubkey !== pubkey) { setLoadError('Only the person who made this playlist can edit it.'); setFormOwner(npub); return; }
      // A restored draft keeps the version it was MADE against. If the playlist changed
      // elsewhere since, SAVE then gets the 409 "changed elsewhere" warning; taking the
      // server's version here would overwrite that change with no word.
      if (cached) apply({ ...cached, editingId: id, expectedUpdatedAt: cached.expectedUpdatedAt ?? p.updatedAt });
      else {
        setTitle(p.title); setDescription(p.description); setOwnerName(p.ownerName ?? ''); setArtUrl(p.artUrl ?? '');
        setSongs(p.songs); setEditingId(p.id); setExpectedUpdatedAt(p.updatedAt);
      }
      setFormOwner(npub);
      if (cached && Object.keys(cached.labels).length) { setCheckReady(true); return; }
      // Titles for the rows: the app's own resolver, one page of RESOLVE_PAGE at a time.
      const l: Labels = {};
      try {
        let offset: number | null = 0;
        while (offset !== null && live) {
          const r: Response = await fetch(`/api/playlist?url=${encodeURIComponent(communityFeedUrl(p.id))}&limit=${RESOLVE_PAGE}&offset=${offset}`);
          const j = r.ok ? await r.json() : null;
          if (!j) break;
          for (const e of (j.episodes ?? []) as Array<{ guid?: string; title?: string; feedTitle?: string; image?: string; feedImage?: string; enclosureUrl?: string; unresolved?: string }>) {
            if (e.guid) {
              known.current[e.guid] = {
                ...(e.enclosureUrl ? { enclosureUrl: e.enclosureUrl } : {}),
                ...(e.unresolved === 'not-found' ? { notFound: true } : {}),
              };
            }
            if (e.guid && e.title && !e.unresolved) {
              l[e.guid] = { title: e.title, ...(e.feedTitle ? { artist: e.feedTitle } : {}), ...((e.image || e.feedImage) ? { image: e.image || e.feedImage } : {}) };
            }
          }
          offset = typeof j.nextOffset === 'number' ? j.nextOffset : null;
        }
      } catch { /* rows keep a plain name */ }
      if (live) { setLabels(l); setCheckReady(true); }
    })();
    return () => { live = false; };
  }, [npub, pubkey]);

  // ---- save the draft after a user change ----------------------------------
  useEffect(() => {
    if (!ready || !dirty || published || deleted || loadError) return;
    const cache: PlaylistDraftCache = {
      draft: { title, description, ownerName, artUrl: artUrl.trim() === '' ? null : artUrl, songs },
      editingId, expectedUpdatedAt, labels,
    };
    if (!npub) guestWork.current = cache;
    const ok = storage.playlistDraft.set(npub, cache, editingId ?? undefined);
    setUnsaved(!ok);
  }, [npub, ready, dirty, published, deleted, loadError, title, description, ownerName, artUrl, songs, labels, editingId, expectedUpdatedAt]);

  const draft: PlaylistDraft = useMemo(
    () => ({ title, description, ownerName, artUrl: artUrl.trim() === '' ? null : artUrl.trim(), songs }),
    [title, description, ownerName, artUrl, songs],
  );
  const verdict = useMemo(() => validatePlaylistDraft(draft, textHoldsSecret), [draft]);
  const blocked = whyNot(verdict, !!identity);
  // What <PublishChecklist> lists: the three requirements, then every other refusal.
  const problems = verdict.ok ? [] : verdict.problems;
  const fewSongs = problems.find((p) => p.kind === 'too-few-songs');
  const otherProblems = problems.filter((p) => p.kind !== 'title-missing' && p.kind !== 'too-few-songs');
  const cleaned = cleanText(title);
  const cleanedDesc = cleanText(description);

  const edit = <T,>(set: (v: T) => void) => (v: T) => { setDirty(true); set(v); };
  const move = (i: number, by: -1 | 1) => { setDirty(true); setSongs((s) => {
    const j = i + by;
    if (j < 0 || j >= s.length) return s;
    const n = s.slice(); [n[i], n[j]] = [n[j], n[i]]; return n;
  }); };
  const remove = (i: number) => { setDirty(true); setSongs((s) => s.filter((_, k) => k !== i)); };

  // Which step failed decides the words: a signer problem must never read as a
  // server problem, or the user retries a request that never left.
  const failure = (e: unknown) => {
    if (e instanceof NoSignerError) return 'No signer is connected. Connect your signer, then try again.';
    if (e instanceof SignTimeoutError) return 'Your signer did not answer. Open it and try again.';
    if (e instanceof SignFailedError) return 'Your signer did not sign. Check that it is connected, then try again.';
    return 'Could not reach the server. Try again.';
  };

  // UPLOAD: the picked file goes to the Blossom server under the user's own key,
  // and only the returned link lands in the art field (lib/community/blossom.ts).
  useEffect(() => {
    setUserServers(null);
    if (!identity) { serversRead.current = null; return; }
    let live = true;
    const p = fetchBlossomServers(identity);
    serversRead.current = p;
    void p.then((s) => { if (live) setUserServers(s); });
    return () => { live = false; };
    // The pubkey, not the identity object: a profile refresh must not read the list again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.pubkey]);

  const uploadArt = async (file: File) => {
    const gen = formGen.current;
    setUploading(true); setUploadNote(null);
    try {
      const servers = userServers ?? (serversRead.current ? await serversRead.current : []);
      const r = await uploadPlaylistArt(file, servers);
      if (gen !== formGen.current) return;
      setDirty(true); setArtUrl(r.url);
      const host = new URL(r.server).host;
      setUploadNote(r.skipped.length
        ? `Your server ${r.skipped.map((s) => new URL(s).host).join(', ')} did not take the picture. It is on ${host}. The link is in the field above.`
        : `Uploaded to ${host}. The link is in the field above.`);
    } catch (e) {
      if (gen !== formGen.current) return;
      setUploadNote(e instanceof ArtUploadError ? UPLOAD_WORDS[e.reason] : failure(e));
    } finally {
      if (gen === formGen.current) setUploading(false);
    }
  };

  // EDIT view: which songs already in the playlist cannot play any more (Chad,
  // 2026-11-15: "make it obvious which ones are dead"). A song can die after it
  // was added — RSS Blue closed under several — and the maker otherwise learns
  // it only when the playlist stops. The same check as + ADD (`whyNotPlayable`),
  // three songs at a time, once per song per load. Only a song found dead is
  // marked: "could not ask" marks nothing.
  useEffect(() => {
    if (!editingId || !checkReady || !ready) return;
    const todo = songs.filter((s) => !checked.current.has(s.itemGuid)).slice(0, MAX_EDIT_CHECKS - checked.current.size);
    if (!todo.length) return;
    for (const s of todo) checked.current.add(s.itemGuid);
    const gen = formGen.current;
    void mapLimit(todo, 3, async (s) => {
      const why = await whyNotPlayable(s.feedGuid, s.itemGuid, known.current[s.itemGuid] ?? {});
      if (why && gen === formGen.current) setDead((d) => ({ ...d, [s.itemGuid]: true }));
    });
  }, [editingId, checkReady, ready, songs]);
  const deadCount = songs.filter((s) => dead[s.itemGuid]).length;

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

  // PUBLISH is never disabled for what is missing: a disabled button answers a
  // press with nothing (Chad, 2026-11-15). A press opens the list of what is
  // missing instead, and sends only a complete playlist.
  const press = () => {
    if (blocked) { setCheckOpen(true); return; }
    void submit();
  };

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

  // Signed out, a NEW playlist gets the form (below); an edit needs its owner.
  if (!identity && editNeedsSignIn) {
    return (
      <section>
        <h1 className="headline text-3xl sm:text-4xl">edit playlist</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-bone/80">Sign in to edit this playlist. Only the person who made it can change it.</p>
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
      {carryNote && <p role="status" className="mt-3 max-w-xl text-xs text-bone/80" data-carry-note>{carryNote}</p>}

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
          <input id="pl-title" ref={titleRef} className="input mt-1" value={title} maxLength={MAX_TITLE_LEN} onChange={(e) => edit(setTitle)(e.target.value)} />
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
            Square is preferred, 1400–3000 px. Empty: BMB makes the cover from the first four songs.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {/* The input is hidden and the button opens it: a bare file input has no
                styling a phone shows as a control. */}
            <input ref={artFileRef} type="file" accept="image/*" className="hidden" data-art-file
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void uploadArt(f);
              }} />
            {/* The upload is signed with the user's key, so signed out the button
                opens the sign-in instead of a file picker it could not use. */}
            <button type="button" className="btn-ghost" disabled={uploading || busy} data-art-upload
              onClick={() => (identity ? artFileRef.current?.click() : setSignInOpen(true))}>
              {uploading ? 'UPLOADING…' : '↑ UPLOAD PICTURE'}
            </button>
            <span className="text-xs text-muted" data-art-upload-host>
              {!identity
                ? 'sign in first: the upload is signed with your Nostr key'
                : userServers === null
                  ? 'signed with your key'
                  : `to ${new URL(artUploadServers(userServers)[0]).host}${userServers.length ? ' (your Blossom server)' : ''}, signed with your key`}
            </span>
          </div>
          {uploadNote && <p className="mt-1 text-xs text-bone/80" role="status" data-art-upload-note>{uploadNote}</p>}
        </div>
      </div>

      {deadCount > 0 && (
        <p role="status" className="mt-6 max-w-xl text-xs text-nostr" data-dead-count>
          ⚠ {deadCount === 1 ? '1 song' : `${deadCount} songs`} in this playlist can&apos;t be played. {deadCount === 1 ? 'It is' : 'They are'} marked below. Remove {deadCount === 1 ? 'it' : 'them'} with ×, then SAVE.
        </p>
      )}
      <div className={`${deadCount > 0 ? 'mt-2' : 'mt-6'} max-w-xl border border-bone/15 bg-ink/90 px-3`} data-songs-panel>
      <ol className="divide-y divide-bone/15" aria-label="Songs">
        {songs.map((s, i) => {
          const l = labels[s.itemGuid];
          return (
            <li key={`${s.feedGuid}:${s.itemGuid}`} className="flex flex-wrap items-center gap-2 py-2" data-song-row {...(dead[s.itemGuid] ? { 'data-song-dead': '' } : {})}>
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
              {dead[s.itemGuid] && (
                <p className="basis-full pl-8 text-[11px] text-nostr">⚠ Track not found. Remove it with ×.</p>
              )}
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
          <button type="button" className="btn-bolt btn-compact" disabled={busy} onClick={press}
            {...(blocked ? { 'aria-haspopup': 'dialog' as const } : {})} data-publish>
            {busy ? '…' : editingId ? 'SAVE' : 'PUBLISH'}
          </button>
          {editingId && (
            <button type="button" className="btn-ghost btn-compact" disabled={busy} onClick={() => setConfirmDelete(true)}>DELETE</button>
          )}
          {blocked && <span className="text-xs text-muted" data-testid="why-blocked">{blocked}</span>}
        </div>
        {identity ? (
          <p className="mt-2 text-xs text-muted">Signed in as {name}. Only you can change this playlist.</p>
        ) : (
          <p className="mt-2 text-xs text-muted" data-testid="signed-out-note">
            You are not signed in. This draft stays on this device.{' '}
            <button type="button" className="btn-inline" onClick={() => setSignInOpen(true)}>Sign in with Nostr</button> to publish it.
          </p>
        )}
        {unsaved && <p className="mt-1 text-xs text-muted" data-testid="unsaved">This draft is not being saved on this device.</p>}
      </div>

      {checkOpen && (
        <PublishChecklist
          action={editingId ? 'SAVE' : 'PUBLISH'}
          signedInAs={identity ? name : null}
          title={problems.some((p) => p.kind === 'title-missing')
            ? null
            // Never quotes a title that holds a key: ALSO FIX names the problem, and the key
            // must not be printed again anywhere (problemText's 'secret' case).
            : problems.some((p) => p.kind === 'secret' && p.field === 'title')
              ? 'Not shown: it holds what looks like a secret key.'
              : cleaned}
          songs={{ ok: !fewSongs, have: fewSongs?.kind === 'too-few-songs' ? fewSongs.have : songs.length }}
          others={otherProblems.map((p) => problemText(p, labels))}
          onClose={() => setCheckOpen(false)}
          onSignIn={() => { setCheckOpen(false); setSignInOpen(true); }}
          onAddTitle={() => {
            setCheckOpen(false);
            // After the dialog hands focus back to PUBLISH on close.
            setTimeout(() => { titleRef.current?.focus(); titleRef.current?.scrollIntoView({ block: 'center' }); }, 0);
          }}
          onAddSongs={() => { setCheckOpen(false); setAddOpen(true); }}
        />
      )}

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
