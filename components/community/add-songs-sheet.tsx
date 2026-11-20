'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { ModalShell } from '@/components/modal-shell';
import { UnderlineTabs, tabPanelProps } from '@/components/underline-tabs';
import { RowThumb } from '@/components/chapter-ui';
import { looksLikeSecretKey } from '@/lib/nostr/npub-input';
import { loadFeed } from '@/lib/podcast-meta';
import { artCandidates, isMusicMedium } from '@/lib/util';
import { whyNotPlayable, type SongKnown } from './song-check';
import { SongPreviewButton } from '@/components/community/song-preview-button';
import type { Episode, Podcast } from '@/lib/types';
import type { PlaylistSong } from '@/lib/community/rules';

/** What the maker keeps for a song so its row has words and a picture. */
export type SongLabel = { title: string; artist?: string; image?: string };

type Tab = 'search' | 'favorites';
const TABS: { id: Tab; label: string }[] = [
  { id: 'search', label: 'SEARCH' },
  { id: 'favorites', label: 'FAVORITES' },
];

const ROW_BTN = 'btn-mini min-w-[5.5rem] shrink-0';
const same = (a: PlaylistSong, feedGuid: string, itemGuid: string) => a.feedGuid === feedGuid && a.itemGuid === itemGuid;

function Thumb({ image, fallback }: { image?: string; fallback?: string }) {
  const [src, alt] = artCandidates(image, fallback, 160);
  return <RowThumb src={src} fallback={alt} className="w-10 h-10 rounded object-cover flex-shrink-0 border border-bone/15" />;
}

/** A row's state while + ADD checks it, or the reason it was refused. */
type Check = { checking: true } | { refused: string };

function SongRow({ title, artist, image, added, onAdd, preview, check }: {
  title: string; artist?: string; image?: string; added: boolean; onAdd?: () => void;
  preview?: { feedGuid: string; itemGuid: string; episode?: Episode; podcast?: Podcast };
  check?: Check;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 py-2" data-add-row>
      {preview ? <SongPreviewButton {...preview} title={title} image={image} /> : <Thumb image={image} />}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{title}</p>
        {artist && <p className="truncate text-xs text-muted">{artist}</p>}
      </div>
      {!onAdd ? (
        <span className="text-[11px] text-muted shrink-0">cannot be added</span>
      ) : added ? (
        <span className={`${ROW_BTN} inline-flex items-center justify-center text-bolt`} data-added>✓ ADDED</span>
      ) : check && 'refused' in check ? (
        <span className="text-[11px] text-muted shrink-0">cannot be added</span>
      ) : (
        <button type="button" className={ROW_BTN} onClick={onAdd} disabled={!!check} aria-label={`Add ${title}`}>
          {check ? 'CHECKING…' : '+ ADD'}
        </button>
      )}
      {check && 'refused' in check && (
        <p className="basis-full text-xs text-muted" role="status" data-add-refused>{check.refused}</p>
      )}
    </li>
  );
}

export function AddSongsSheet({ songs, onAdd, onClose, playlistTitle }: {
  songs: PlaylistSong[];
  onAdd: (s: PlaylistSong, label: SongLabel) => void;
  onClose: () => void;
  playlistTitle: string;
}) {
  const [tab, setTab] = useState<Tab>('search');
  const has = (feedGuid: string, itemGuid: string) => songs.some((s) => same(s, feedGuid, itemGuid));

  // Each row's check, by item guid. A song is added only after `whyNotPlayable`
  // says yes; a refusal stays on its row with the reason.
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const checkThenAdd = async (
    song: PlaylistSong,
    label: SongLabel,
    known: SongKnown,
  ) => {
    const k = song.itemGuid;
    if (checks[k]) return;
    setChecks((c) => ({ ...c, [k]: { checking: true } }));
    const why = await whyNotPlayable(song.feedGuid, song.itemGuid, known);
    if (!live.current) return;
    if (why) {
      setChecks((c) => ({ ...c, [k]: { refused: why } }));
      return;
    }
    setChecks((c) => { const n = { ...c }; delete n[k]; return n; });
    onAdd(song, label);
  };

  // ---- SEARCH ---------------------------------------------------------------
  const [q, setQ] = useState('');
  const [albums, setAlbums] = useState<Podcast[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [album, setAlbum] = useState<{ podcast: Podcast; episodes: Episode[] } | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const secret = useMemo(() => looksLikeSecretKey(q), [q]);

  // A generation counter: clearTimeout cannot reach a request already in flight, so a slow answer for
  // "bow" must not replace the results for "bowl after bowl".
  const genRef = useRef(0);
  useEffect(() => {
    // An nsec is refused before any fetch: a key sent to a server cannot be recalled.
    setOpenError(null);
    if (!q.trim() || secret) {
      genRef.current++;
      setAlbums(null); setSearching(false); setSearchError(false);
      return;
    }
    const gen = ++genRef.current;
    const timer = setTimeout(async () => {
      setSearching(true); setSearchError(false);
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}&type=music`);
        if (!r.ok) throw new Error(`search ${r.status}`);
        const data = await r.json();
        if (gen !== genRef.current) return;
        setAlbums(Array.isArray(data?.feeds) ? (data.feeds as Podcast[]) : []);
      } catch {
        if (gen === genRef.current) { setAlbums([]); setSearchError(true); }
      } finally {
        if (gen === genRef.current) setSearching(false);
      }
    }, 280);
    return () => clearTimeout(timer);
  }, [q, secret]);

  async function openAlbum(p: Podcast) {
    setOpening(p.id); setOpenError(null);
    try {
      const res = await loadFeed(p.id > 0 ? { feedId: p.id } : { feedUrl: p.url ?? '' });
      if (!res.podcast || !res.episodes) { setOpenError('Could not open that album. Try again.'); return; }
      if (!isMusicMedium(res.podcast)) { setOpenError('That feed is not a music album.'); return; }
      setAlbum({ podcast: res.podcast, episodes: res.episodes });
      setOpenError(null);
    } catch {
      setOpenError('Could not open that album. Try again.');
    } finally {
      setOpening(null);
    }
  }

  // ---- FAVORITES ------------------------------------------------------------
  const favoriteEpisodes = useApp((s) => s.favoriteEpisodes);
  const favSongs = useMemo(
    () => Object.values(favoriteEpisodes)
      // A favorite of unknown medium is a track only in the shape <FavTrackHeart> writes: it sets no
      // enclosureUrl, where <FavEpisodeHeart> always does.
      .filter((f) => f.itemGuid && f.feedGuid && (f.medium === undefined ? !f.enclosureUrl : f.medium.toLowerCase() === 'music'))
      .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0)),
    [favoriteEpisodes],
  );

  // An empty library is a claim: make it only once the read has answered.
  const sync = useApp((s) => s.favoritesSync);
  // Signed out the read never starts (`favoritesSync` stays 'idle'), so "Loading" would never end.
  const signedIn = useApp((s) => !!s.identity);
  const albumGuid = album?.podcast.podcastGuid;
  return (
    <ModalShell onClose={onClose} label="Add songs" className="w-full max-w-2xl h-full" clearsPlayer={false}>
      <div className="sticky top-0 z-10 bg-ink border-b border-bone/15 px-4 pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-display text-xl">Add songs</h2>
            <p className="truncate text-xs text-muted" data-testid="add-count">{songs.length} in {playlistTitle.trim() || 'your playlist'}</p>
          </div>
          <button type="button" className="btn-bolt btn-compact shrink-0" onClick={onClose}>DONE</button>
        </div>
        <UnderlineTabs tabs={TABS} active={tab} onChange={setTab} idBase="add-songs" className="mt-2 -mx-4 px-2 border-b-0" />
      </div>

      <div className="px-4 pb-6 pt-3" {...tabPanelProps('add-songs', tab)}>
        {tab === 'search' && !album && (
          <>
            <div className="flex items-center gap-2">
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search albums and artists"
                aria-label="Search albums and artists"
                className="min-w-0 flex-1 bg-transparent border border-bone/40 px-3 py-2 text-sm focus:border-bone outline-none"
                autoComplete="off"
              />
              <span className="stamp shrink-0">♫ MUSIC</span>
            </div>
            <p className="mt-2 text-xs text-muted">Pick songs one at a time. A whole album cannot go in.</p>
            {secret && (
              <p role="alert" className="mt-3 border border-bone/30 p-3 text-sm" data-testid="search-secret">
                That looks like a secret key. It was not sent. Never paste it into a search box.
              </p>
            )}
            {openError && <p role="alert" className="mt-3 text-sm text-muted">{openError}</p>}
            {searching && <p className="mt-3 text-sm text-muted">Searching…</p>}
            {searchError && <p className="mt-3 text-sm text-muted">Search failed. Try again.</p>}
            {!searching && !searchError && albums && albums.length === 0 && (
              <p className="mt-3 text-sm text-muted">No albums found. Try another word.</p>
            )}
            {albums && albums.length > 0 && (
              <ul className="mt-2 divide-y divide-bone/15" aria-label="Albums">
                {albums.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 py-2 text-left min-h-11"
                      onClick={() => openAlbum(p)}
                      disabled={opening !== null}
                      data-album-row
                    >
                      <Thumb image={p.image} fallback={p.artwork} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{p.title}</span>
                        {p.author && <span className="block truncate text-xs text-muted">{p.author}</span>}
                      </span>
                      <span className="text-[11px] text-muted shrink-0">{opening === p.id ? '…' : 'OPEN ›'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {tab === 'search' && album && (
          <>
            <button type="button" className="btn-mini" onClick={() => { setAlbum(null); setOpenError(null); }}>← RESULTS</button>
            <h3 className="mt-3 truncate font-display text-lg">{album.podcast.title}</h3>
            <p className="mt-1 text-xs text-muted">Pick songs one at a time. A whole album cannot go in.</p>
            {album.episodes.length === 0 && <p className="mt-3 text-sm text-muted">This album has no songs.</p>}
            <ul className="mt-2 divide-y divide-bone/15" aria-label="Songs in this album">
              {album.episodes.map((e) => {
                const feedGuid = e.podcastGuid ?? albumGuid;
                const ok = !!e.guid && !!feedGuid;
                const artist = album.podcast.author ?? album.podcast.title;
                const image = e.image ?? album.podcast.image;
                // The album's URL is the item's feed only when the item belongs to that album.
                const feedUrl = album.podcast.url && feedGuid === albumGuid ? album.podcast.url : undefined;
                return (
                  <SongRow
                    key={e.id}
                    title={e.title}
                    artist={artist}
                    image={image}
                    preview={ok ? { feedGuid: feedGuid!, itemGuid: e.guid!, episode: e, podcast: album.podcast } : undefined}
                    added={ok && has(feedGuid!, e.guid!)}
                    check={ok ? checks[e.guid!] : undefined}
                    onAdd={ok ? () => checkThenAdd(
                      { feedGuid: feedGuid!, itemGuid: e.guid!, ...(feedUrl ? { feedUrl } : {}) },
                      {
                        title: e.title,
                        ...(artist ? { artist } : {}),
                        ...(image ? { image } : {}),
                      },
                      { enclosureUrl: e.enclosureUrl, feedUrl: album.podcast.url },
                    ) : undefined}
                  />
                );
              })}
            </ul>
          </>
        )}

        {tab === 'favorites' && (
          favSongs.length === 0 ? (
            !signedIn ? (
              <p className="text-sm text-muted" data-testid="fav-signed-out">Sign in with Nostr to add songs you saved with ♡. SEARCH works now.</p>
            ) : sync === 'idle' || sync === 'loading' ? (
              <p className="text-sm text-muted" data-testid="fav-loading">Loading your saved songs…</p>
            ) : sync === 'degraded' ? (
              <p className="text-sm text-muted" data-testid="fav-degraded">Your saved songs could not be read. Try again later.</p>
            ) : (
              <p className="text-sm text-muted">No saved songs yet. Tap ♡ on a song to save it.</p>
            )
          ) : (
            <ul className="divide-y divide-bone/15" aria-label="Saved songs">
              {favSongs.map((f) => (
                <SongRow
                  key={f.itemGuid}
                  title={f.title ?? 'Song'}
                  artist={f.podcastTitle}
                  image={f.image}
                  preview={{ feedGuid: f.feedGuid!, itemGuid: f.itemGuid }}
                  added={has(f.feedGuid!, f.itemGuid)}
                  check={checks[f.itemGuid]}
                  onAdd={() => checkThenAdd(
                    { feedGuid: f.feedGuid!, itemGuid: f.itemGuid, ...(f.feedUrl ? { feedUrl: f.feedUrl } : {}) },
                    { title: f.title ?? 'Song', ...(f.podcastTitle ? { artist: f.podcastTitle } : {}), ...(f.image ? { image: f.image } : {}) },
                    { enclosureUrl: f.enclosureUrl, feedUrl: f.feedUrl },
                  )}
                />
              ))}
            </ul>
          )
        )}
      </div>
    </ModalShell>
  );
}
