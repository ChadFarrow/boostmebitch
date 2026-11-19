'use client';

// /demu — every self-hosted (DeMu) music album, newest track first, in week,
// month and year groups, with a search box that filters the whole list.
// Design: docs/superpowers/specs/2026-11-15-demu-page-design.md; the list
// logic is pure and pinned in lib/demu.ts (`check:demu`).
//
// The whole roster arrives in one answer (`/api/demu`, ~110 KB compressed) and
// everything after that happens here: that is what makes the search instant
// AND complete — a broad word like "bitcoin" finds every DeMu album, which the
// DEMU search type (a filter over PI's ranked rows) cannot.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PodcastResults } from '@/components/lists';
import { ShowMore, useAutoReveal, useRevealed } from '@/components/lists/grouping';
import { useAlbumCoverPlay } from '@/components/lists/use-album-cover-play';
import { useApp } from '@/lib/store';
import { DEMU_APPS, demuAge, demuDateLabel, demuGroups, matchesDemuQuery, sortDemuAlbums } from '@/lib/demu';
import type { DemuAlbum } from '@/lib/demu';
import { demuView } from '@/lib/demu-view';
import type { Podcast } from '@/lib/types';
import { EmuIcon } from './icons';

const DEMU_ORIGIN = { path: '/demu', label: 'DeMu' };

/**
 * `failed` covers BOTH a failed request and `answered: false` (a cold or
 * unreachable roster). It is never rendered as an empty list: "no DeMu albums"
 * would be a claim about the music, made out of our own failure to ask.
 */
type Load =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'loaded'; albums: DemuAlbum[]; now: number };

const count = (n: number) => `${n.toLocaleString('en-US')} DeMu album${n === 1 ? '' : 's'}`;

function trackLabel(n: number | undefined): string {
  if (n === undefined) return '';
  return n === 1 ? 'single' : `${n} tracks`;
}

export function DemuPage() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  // Restored from where the listener left off (or from the DEMU search that
  // linked here) — see lib/demu-view.ts.
  const [query, setQuery] = useState(demuView.query);
  const selectPodcast = useApp((s) => s.selectPodcast);
  const setShowOrigin = useApp((s) => s.setShowOrigin);
  const router = useRouter();
  // A press on a cover plays the album; the rest of the row opens it.
  const coverPlay = useAlbumCoverPlay();

  const fetchList = useCallback(async () => {
    setLoad({ status: 'loading' });
    try {
      const r = await fetch('/api/demu');
      const data = r.ok ? await r.json() : null;
      // An answered roster with NO albums read nothing (the server no longer
      // caches one, but a CDN copy or an older server could still send it):
      // "could not load", never "0 DeMu albums" over an empty-quotes no-match.
      if (data?.answered === true && Array.isArray(data.albums) && data.albums.length > 0) {
        setLoad({ status: 'loaded', albums: data.albums as DemuAlbum[], now: Date.now() });
      } else {
        setLoad({ status: 'failed' });
      }
    } catch {
      setLoad({ status: 'failed' });
    }
  }, []);
  useEffect(() => { void fetchList(); }, [fetchList]);

  // One `now` per load, so the headings do not move while somebody scrolls.
  const now = load.status === 'loaded' ? load.now : 0;
  const albums = useMemo(() => (load.status === 'loaded' ? load.albums : []), [load]);
  const sorted = useMemo(
    () => sortDemuAlbums(albums.filter((a) => matchesDemuQuery(a, query)), Math.floor(now / 1000)),
    [albums, query, now],
  );
  const { visible, remaining, more, shown } = useRevealed(
    sorted,
    query,
    demuView.query === query ? demuView.shown : undefined,
  );
  const sentinel = useAutoReveal(remaining, more);
  const groups = useMemo(() => demuGroups(visible, new Date(now)), [visible, now]);

  // Keep the words and the revealed count for a return visit; the scroll
  // position is saved at the moment an album opens (see `openAlbum`), because
  // by the time this component unmounts the router may already have scrolled.
  const latest = useRef({ query, shown });
  useEffect(() => { latest.current = { query, shown }; }, [query, shown]);
  useEffect(() => () => {
    demuView.query = latest.current.query;
    demuView.shown = latest.current.shown;
  }, []);

  // Back from an album: return to the same place once the rows are on screen.
  useEffect(() => {
    if (load.status !== 'loaded' || demuView.scrollY <= 0) return;
    const y = demuView.scrollY;
    demuView.scrollY = 0;
    requestAnimationFrame(() => window.scrollTo(0, y));
  }, [load.status]);

  /**
   * Open an album the way /playlists does: set the store, THEN navigate to `/`.
   * Never `router.push('/?podcast=…')` — see `openPlaylist` in
   * components/playlists-page.tsx for why. `setShowOrigin` comes AFTER
   * `selectPodcast`, which clears it, and gives the show page "← back to DeMu".
   */
  function openAlbum(p: Podcast) {
    demuView.query = query;
    demuView.shown = shown;
    demuView.scrollY = window.scrollY;
    selectPodcast(p);
    setShowOrigin(DEMU_ORIGIN);
    router.push('/');
  }

  // The track count rides on the author line (it may be cut on a narrow
  // phone); the date and age get their own line, which is never cut — Chad
  // chose this layout for the dates, "especially for mobile".
  const meta = (p: Podcast) => trackLabel((p as unknown as DemuAlbum).episodeCount) || null;
  const detail = (p: Podcast) => {
    const a = p as unknown as DemuAlbum;
    const at = new Date(now);
    const date = demuDateLabel(a.newestItemPubdate, at);
    const age = demuAge(a.newestItemPubdate, at);
    if (!date && !age) return null;
    return (
      <>
        {date}
        {age ? <span data-demu-age className="text-bolt">{date ? ' · ' : ''}{age}</span> : null}
      </>
    );
  };

  // Shown without a value block (Homegrown Hits plays it, or MSP made it): say so
  // rather than hide it — Chad, 2026-11-16. Only when PI said none (`valueMissing`).
  const stamp = (p: Podcast) =>
    (p as unknown as DemuAlbum).valueMissing ? (
      <span
        data-demu-novalue
        className="stamp text-muted border-muted/40"
        title="This feed has no <podcast:value> block, so a boost has no one to pay."
      >
        NO VALUE BLOCK
      </span>
    ) : null;

  // Which app made the feed, as a logo in the cover's top-left corner — LNBeats'
  // idea, "just for at a glance" (Chad, 2026-11-16). Top-left, not top-right, at
  // Chad's choice after the mockups. A cached answer from before `app` existed
  // draws no badge.
  const coverBadge = (p: Podcast) => {
    const app = (p as unknown as DemuAlbum).app;
    if (!app) return null;
    const label = DEMU_APPS[app].label;
    return (
      <span
        data-demu-app={app}
        role="img"
        aria-label={label}
        title={label}
        className={`absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full overflow-hidden border border-ink flex items-center justify-center ${app === 'podhome' ? 'bg-bone' : 'bg-ink'}`}
      >
        {app === 'self' ? (
          // The search menu's DEMU glyph, so the badge and the type it was
          // found under are one shape.
          <EmuIcon className="w-3.5 h-3.5 text-bolt" />
        ) : (
          // A 96 px file from /public, drawn at 20 px: `next/image` would only add a
          // resize round trip for an icon this small.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/demu-apps/${app}.png`} alt="" width={20} height={20} className="w-full h-full object-cover" />
        )}
      </span>
    );
  };

  const q = query.trim();

  return (
    <>
      {/* The emu: the search menu's DEMU glyph, so the page wears the shape of the
          type it lists (Chad, 2026-11-19: "use that logo for the DeMu page as well").
          The badge on a self-hosted cover below is the same component. */}
      <h1 data-demu-title className="headline text-3xl sm:text-4xl flex items-center gap-2">
        <EmuIcon className="w-[1em] h-[1em] text-bolt" />
        DeMu
      </h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-bone/80">
        Self-hosted music.
      </p>

      <label className="mt-6 block max-w-xl">
        <span className="block text-[10px] uppercase tracking-[0.18em] text-muted mb-1.5">Search DeMu</span>
        <input
          className="input min-h-11"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="artist, album or single…"
          enterKeyHint="search"
        />
      </label>

      {load.status === 'loading' && (
        <p className="text-[11px] uppercase tracking-widest text-muted mt-4 px-1">loading DeMu…</p>
      )}

      {load.status === 'failed' && (
        <p className="text-sm mt-4 px-1 flex flex-wrap items-center gap-3">
          <span className="text-muted">Could not load the DeMu list.</span>
          <button type="button" onClick={() => void fetchList()} className="btn-ghost btn-compact">
            try again
          </button>
        </p>
      )}

      {load.status === 'loaded' && (
        <>
          <div className="text-[11px] uppercase tracking-widest text-muted mt-4 mb-2 px-1">
            {q ? `${count(sorted.length)} match “${q}”` : count(sorted.length)}
          </div>
          {sorted.length === 0 ? (
            <p className="text-muted text-sm py-4 px-1">No DeMu albums match “{q}”.</p>
          ) : (
            <>
              {groups.map((g) => (
                <section key={g.key} className="mt-4">
                  <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-bolt border-b border-bolt/40 pb-1.5 mb-1 px-1">
                    {g.label}
                  </h2>
                  <PodcastResults feeds={g.albums} selected={null} onSelect={openAlbum} meta={meta} detail={detail} stamp={stamp} coverBadge={coverBadge} coverPlay={coverPlay} />
                </section>
              ))}
              <ShowMore remaining={remaining} onClick={more} noun="DeMu albums" innerRef={sentinel} />
            </>
          )}
        </>
      )}
    </>
  );
}
