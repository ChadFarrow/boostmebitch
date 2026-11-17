'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { storage } from '@/lib/storage';
import { loadCollection } from '@/lib/playlist-collection';
import { readCappedJson } from '@/lib/capped-body';
import { fmtDate } from '@/lib/format';
import { fnvHash, isPlaylistMedium, NEW_EPISODES_LATEST_MAX_FEEDS } from '@/lib/util';
import {
  albumKeys, mergeNewMusicRows, newMusicArtists, planPublisher, pruneNewMusic, rowKey, selectNewMusic, splitListing,
  stalestFirst,
  type NewMusicAlbum, type NewMusicArtist, type NewMusicRecord, type NewMusicRow, type PublisherPlan,
} from '@/lib/new-music';
import { setArtistFollow, useArtistFollows } from '@/lib/use-artist-follows';
import { PodcastCover } from './podcast-cover';
import { CollapsibleHeading, useCollapsedGroups } from './lists/grouping';
import type { FavoritePodcast, Podcast } from '@/lib/types';

/**
 * "New music" — new albums from the ARTISTS the reader favorited.
 *
 * **An artist is a favorited PUBLISHER FEED** (`medium: 'publisher'`): the feed
 * a music host publishes per artist, listing the artist's albums as
 * `<podcast:remoteItem>`s. A search hit for one carries the `▸ ALBUMS` stamp and
 * the ordinary ♡, which saves it as a feed favorite like any show. A new album
 * is a NEW FEED, so `<FavoritesNewEpisodes>` — which asks Podcast Index what
 * came out on feeds already in the library — can never see one. The publisher
 * feed is the only document that names it. The decisions are in
 * `lib/new-music.ts` (pinned by `check:newmusic`); this file is the wiring.
 *
 * **A SECTION BESIDE NEW EPISODES, NOT INSIDE IT.** The two answer different
 * questions from different documents, on different clocks: an episode check
 * costs one Podcast Index call per hundred shows, a publisher read costs one
 * RSS fetch plus a PI call per album it lists. Folding them together would make
 * one throttle wrong for one of them.
 *
 * **EACH ARTIST IS ONE `/api/publisher` REQUEST, IN SERIES.** That route is the
 * one the playlists page and the publisher view already use, so a read here
 * resolves the albums exactly as those surfaces show them, and its five-minute
 * shared cache serves every reader who follows the same artist. It allows 30
 * requests a minute per IP, a phone and a desktop share one household IP, and
 * each request already fans out to Podcast Index, so the pass never bursts:
 * `MAX_ARTISTS` per pass, one at a time, stalest first, the rest `deferred` to
 * the next pass.
 *
 * **A FIRST LOOK AT AN ARTIST SHOWS ITS LATEST ALBUM, once, if it is under 90
 * days old** — the rule `<FavoritesNewEpisodes>` follows for a show's first
 * check (the owner's choice there, 2026-10-01). Every album listed is marked
 * seen on that look, so the next pass announces only what the artist adds.
 * The "how old" comes from `/api/new-episodes?latest=1`, which already answers
 * an album's newest track per PI feed id.
 *
 * Every state is named, the NEW EPISODES way: a read that failed is "could not
 * check", never "nothing new", and an artist the pass did not reach is
 * "not checked yet", never a failure.
 *
 * **A PLAYLIST MAKER'S PUBLISHER FEED IS NOT AN ARTIST** (the owner's choice,
 * 2026-11-17). It looks like one until it is read: the medium is `publisher`
 * either way, and only the children say `musicL`. So the pass finds it out
 * (`splitListing`), keeps it in the record's `makers`, and from then on it
 * makes no row and is not counted. It is still read each pass, so a feed that
 * starts to list albums becomes an artist again, with a first look.
 */

/** A pass runs at most this often. Publisher feeds change far more slowly than
 *  shows publish, and a pass is the costliest read on this page. */
const CHECK_MIN_MS = 60 * 60 * 1000;
/**
 * Artists one pass asks about. Each is a request against `/api/publisher`'s 30
 * a minute per IP — shared with the playlists page — so 20 in series leaves
 * room for a reader browsing at the same moment. A larger following is covered
 * over the next passes, stalest first; nothing is lost, only later.
 */
const MAX_ARTISTS = 20;
/**
 * Longer than `<FavoritesNewEpisodes>`' settle window (1.2 s), so its pass
 * starts first: both hit `/api/new-episodes`, and a reader opening the page
 * should see the episodes answer first. Restarted by each change to the ask
 * set, so a cold hydration produces one pass over the settled library.
 */
const SETTLE_MS = 2500;
/** Rows revealed at a time — each mounts a `<PodcastCover>` of third-party art. */
const PAGE = 12;

type Phase = 'idle' | 'checking' | 'done';

const isPublisher = (f: FavoritePodcast) => f.medium?.toLowerCase() === 'publisher';

/** The publisher feeds among the reader's favorites, as NEW MUSIC artists. */
const favoriteArtists = (favs: Record<string, FavoritePodcast>): NewMusicArtist[] =>
  Object.values(favs)
    .filter((f) => isPublisher(f) && !!f.podcastGuid)
    .map((f) => ({ podcastGuid: f.podcastGuid, url: f.url, title: f.title }));

/** Only the fields the row renders and opens with. `storage.newMusic` keeps the
 *  same whitelist, so a full `Podcast` never reaches the key either way. */
function pickAlbum(p: NewMusicAlbum): NewMusicAlbum {
  const a: NewMusicAlbum = { id: p.id > 0 ? p.id : 0, title: p.title };
  if (p.podcastGuid) a.podcastGuid = p.podcastGuid;
  if (p.url) a.url = p.url;
  if (p.author) a.author = p.author;
  if (p.image) a.image = p.image;
  if (p.artwork) a.artwork = p.artwork;
  if (p.medium) a.medium = p.medium;
  return a;
}

/**
 * The album as the show page needs it. An album Podcast Index does not hold
 * yet is stored with id 0 and opens by its feed URL, which `<HomePage>` does
 * only for a record marked `isPreview`, and `<EpisodeList>` only with a
 * non-zero id — so it gets the id the RSS reader gives a preview feed,
 * `-fnvHash(url)` (`previewPodcastFromChannel` in `lib/pi.ts`). null when
 * there is neither, because a row that cannot open must not look like it can.
 */
function albumAsPodcast(a: NewMusicAlbum): Podcast | null {
  if (a.id > 0) return { ...a };
  if (a.url) return { ...a, id: -fnvHash(a.url), isPreview: true };
  return null;
}

export function FavoritesNewMusic({ onOpen }: { onOpen?: (p: Podcast) => void }) {
  const favorites = useApp((s) => s.favorites);
  const identity = useApp((s) => s.identity);
  const favoritesSync = useApp((s) => s.favoritesSync);
  const [mounted, setMounted] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [rows, setRows] = useState<NewMusicRow[]>([]);
  const [record, setRecord] = useState<NewMusicRecord>({ checkedAt: 0, seen: {}, checked: {}, rows: [] });
  /** Artists a request was made for that did not come back, PLUS favorites
   *  with no feed address to ask with. Either way: not checked, never quiet. */
  const [uncovered, setUncovered] = useState(0);
  /** Artists this pass did not reach because of `MAX_ARTISTS`. Not a failure. */
  const [deferred, setDeferred] = useState(0);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [saved, setSaved] = useState(true);
  const [shown, setShown] = useState(PAGE);
  const [collapsed, toggleCollapsed] = useCollapsedGroups();
  /** Keyed by account, as in `<FavoritesNewEpisodes>`: a boolean left true by
   *  account A's pass refused account B's first check after a switch. */
  const running = useRef<string | null>(null);

  useEffect(() => setMounted(true), []);

  const npub = identity?.npub ?? null;
  const npubNow = useRef(npub);
  npubNow.current = npub;

  // Paint what this device already found, before any request.
  useEffect(() => {
    const stored = storage.newMusic.get(npub);
    setRecord(stored);
    setRows(stored.rows);
    setUncovered(stored.uncovered ?? 0);
  }, [npub]);

  /** Artists followed with ♡ ARTIST on this device (never on the shared list). */
  const follows = useArtistFollows(npub);
  /** Every artist this section asks about: publisher favorites, then device
   *  follows (`newMusicArtists`). */
  const publishers = useMemo(
    () => newMusicArtists(favoriteArtists(favorites), follows),
    [favorites, follows],
  );
  /** A stable key over the ASK SET — `favorites` is replaced wholesale on every
   *  heart, and only the artists and their addresses can change the answer. */
  const askKey = useMemo(
    () => publishers.map((f) => `${f.podcastGuid}|${f.url ?? ''}`).sort().join(','),
    [publishers],
  );

  const check = useCallback(async (force: boolean) => {
    const runKey = npub ?? ':guest';
    if (running.current === runKey) return;
    const onScreen = () => npubNow.current === npub;

    const favs = useApp.getState().favorites;
    const pubs = newMusicArtists(favoriteArtists(favs), storage.artistFollows.get(npub));
    // PRUNED FIRST, so an unfavorited artist's rows leave at the next visit
    // even when the throttle stops the pass from asking anything.
    const stored = pruneNewMusic(storage.newMusic.get(npub), pubs.map((f) => f.podcastGuid));
    const byGuid = new Map(pubs.map((f) => [f.podcastGuid, f]));
    const askable = pubs.filter((f) => !!f.url && /^https?:\/\//i.test(f.url));
    const noAddress = pubs.length - askable.length;
    const asked = stalestFirst(askable.map((f) => f.podcastGuid), stored.checked)
      .slice(0, MAX_ARTISTS)
      .map((g) => byGuid.get(g)!);
    setDeferred(askable.length - asked.length);

    if (!force && Date.now() - stored.checkedAt < CHECK_MIN_MS) {
      // Inside the throttle: repaint the stored list and the stored outcome.
      setRecord(stored);
      setRows(stored.rows);
      setUncovered(stored.uncovered ?? 0);
      setPhase('done');
      return;
    }
    if (!asked.length) {
      setUncovered(noAddress);
      setPhase('done');
      return;
    }

    running.current = runKey;
    setPhase('checking');
    setProgress({ done: 0, total: asked.length });
    const now = Date.now();
    const seen = { ...stored.seen };
    const checked = { ...stored.checked };
    const plans: { pub: NewMusicArtist; plan: PublisherPlan }[] = [];
    const makers = new Set(stored.makers ?? []);
    let failed = 0;

    try {
      for (const pub of asked) {
        // null is "could not read" — a failed request, an unreadable feed, or
        // none of its albums resolving. Its `seen` stays as it was, so nothing
        // it lists is skipped over, and it counts as not checked.
        const c = await loadCollection(pub.url!);
        if (c) {
          checked[pub.podcastGuid] = Date.now();
          const { albums, maker } = splitListing(c.feeds, isPlaylistMedium);
          if (maker) {
            // A playlist maker: nothing it lists is an album, so it keeps no
            // `seen`. If it lists albums one day, that is a first look.
            makers.add(pub.podcastGuid);
            delete seen[pub.podcastGuid];
          } else {
            makers.delete(pub.podcastGuid);
            const plan = planPublisher(stored.seen[pub.podcastGuid], albums);
            seen[pub.podcastGuid] = plan.nextSeen;
            plans.push({ pub, plan });
          }
        } else {
          failed += 1;
        }
        if (onScreen()) setProgress((p) => ({ done: p.done + 1, total: p.total }));
      }

      /**
       * THE DATES, for the candidates Podcast Index holds: each album's newest
       * track, one PI call per album through the route's `latest=1` branch, in
       * series, `NEW_EPISODES_LATEST_MAX_FEEDS` a request. A later look with a
       * failed request still shows a new album, undated — the safe direction.
       */
      const ids = [...new Set(plans.flatMap(({ plan }) => plan.candidates.map((a) => a.id)).filter((id) => id > 0))];
      const dates: Record<number, number> = {};
      const undated = new Set<number>();
      for (let i = 0; i < ids.length; i += NEW_EPISODES_LATEST_MAX_FEEDS) {
        const chunk = ids.slice(i, i + NEW_EPISODES_LATEST_MAX_FEEDS);
        try {
          const res = await fetch(`/api/new-episodes?latest=1&feeds=${chunk.join(',')}`);
          if (!res.ok) throw new Error(String(res.status));
          const data = (await readCappedJson(res)) as { episodes?: unknown };
          const episodes = Array.isArray(data.episodes) ? data.episodes : [];
          for (const e of episodes as { feedId?: unknown; datePublished?: unknown }[]) {
            if (typeof e?.feedId !== 'number' || typeof e.datePublished !== 'number') continue;
            dates[e.feedId] = Math.max(dates[e.feedId] ?? 0, e.datePublished);
          }
        } catch {
          for (const id of chunk) undated.add(id);
        }
      }

      /**
       * A FIRST LOOK WHOSE DATES DID NOT COME BACK IS NOT A FIRST LOOK YET.
       * Writing its seen list would mark the whole catalogue seen with no
       * "latest" named, so the artist's newest album could never show — on a
       * 429 from Podcast Index, which is ordinary (measured 2026-11-15 on
       * Nate Johnivan's Wavlake feed). So that artist keeps no seen list and no
       * check time, counts as "could not check", and the next pass looks again.
       */
      const notYet = new Set(
        plans
          .filter(({ plan }) => plan.first && plan.candidates.some((a) => undated.has(a.id)))
          .map(({ pub }) => pub.podcastGuid),
      );
      for (const g of notYet) {
        delete seen[g];
        if (stored.checked[g] !== undefined) checked[g] = stored.checked[g];
        else delete checked[g];
        failed += 1;
      }

      const favoriteKeys = new Set(Object.values(favs).flatMap((f) => albumKeys(f)));
      const nowSec = Math.floor(Date.now() / 1000);
      const fresh: NewMusicRow[] = plans.filter(({ pub }) => !notYet.has(pub.podcastGuid)).flatMap(({ pub, plan }) =>
        selectNewMusic({ first: plan.first, candidates: plan.candidates, dates, nowSec, favoriteKeys }).map((r) => {
          const row: NewMusicRow = { album: pickAlbum(r.album), publisherGuid: pub.podcastGuid, foundAt: now };
          if (pub.title) row.publisherTitle = pub.title;
          if (r.date !== undefined) row.date = r.date;
          return row;
        }),
      );

      // Read the disk AGAIN for what the reader removed while the pass ran: ✕
      // and CLEAR write their keys straight to disk, and the rows this pass
      // started from would otherwise bring them back.
      const latest = storage.newMusic.get(npub);
      const dismissedKeys = new Set([...(stored.dismissed ?? []), ...(latest.dismissed ?? [])]);
      const keptRows = stored.rows.filter(
        (r) => !makers.has(r.publisherGuid) && latest.rows.some((l) => rowKey(l) === rowKey(r)),
      );
      const next: NewMusicRecord = {
        checkedAt: now,
        seen,
        checked,
        rows: mergeNewMusicRows(keptRows, fresh, dismissedKeys),
        dismissed: latest.dismissed ?? stored.dismissed,
        uncovered: failed + noAddress,
        makers: [...makers],
      };
      const ok = storage.newMusic.set(npub, next);
      if (onScreen()) {
        setSaved(ok);
        setRecord(next);
        setRows(next.rows);
        setUncovered(next.uncovered ?? 0);
        setShown(PAGE);
      }
    } finally {
      if (running.current === runKey) running.current = null;
      if (onScreen()) setPhase('done');
    }
  }, [npub]);

  /** CLEAR: the rows go and `seen` stays, so the next pass does not bring them back. */
  const clearRows = useCallback(() => {
    const stored = storage.newMusic.get(npub);
    const next: NewMusicRecord = {
      ...stored,
      rows: [],
      dismissed: [...(stored.dismissed ?? []), ...stored.rows.map(rowKey)],
    };
    setSaved(storage.newMusic.set(npub, next));
    setRecord(next);
    setRows([]);
    setShown(PAGE);
  }, [npub]);

  /** ✕ on one row — CLEAR's rule for that row alone, filtered on DISK. */
  const dismissRow = useCallback((row: NewMusicRow) => {
    const k = rowKey(row);
    const stored = storage.newMusic.get(npub);
    const next: NewMusicRecord = {
      ...stored,
      rows: stored.rows.filter((r) => rowKey(r) !== k),
      dismissed: [...(stored.dismissed ?? []), k],
    };
    setSaved(storage.newMusic.set(npub, next));
    setRecord(next);
    setRows((list) => list.filter((r) => rowKey(r) !== k));
  }, [npub]);

  /**
   * The rows of artists STILL favorited. The pass prunes the record, but it
   * waits out `SETTLE_MS` and the throttle may stop it from writing, so the
   * stored list can still hold an artist the reader just unfavorited. Hidden
   * at render, never deleted here: an unhydrated store is not a removal.
   */
  const visible = useMemo(() => {
    const makers = new Set(record.makers ?? []);
    const live = new Set(publishers.map((f) => f.podcastGuid));
    return rows.filter((r) => live.has(r.publisherGuid) && !makers.has(r.publisherGuid));
  }, [rows, publishers, record.makers]);
  /** The artists the heading counts: every publisher not found to be a
   *  playlist maker. Before its first read, a maker still counts. */
  const artistCount = useMemo(() => {
    const makers = new Set(record.makers ?? []);
    return publishers.filter((f) => !makers.has(f.podcastGuid)).length;
  }, [publishers, record.makers]);

  // Signed in, the library is not settled until the relay read lands — the
  // `<FavoritesNewEpisodes>` rule: a pass over the cached subset stamps
  // `checkedAt` and the throttle then refuses the pass the full list needed.
  const hydrating = !!npub && (favoritesSync === 'idle' || favoritesSync === 'loading');

  useEffect(() => {
    if (!mounted || !askKey || hydrating) return;
    const t = setTimeout(() => void check(false), SETTLE_MS);
    return () => clearTimeout(t);
  }, [mounted, askKey, check, hydrating]);

  // Hidden with no favorited artist: a heading over an empty list would be a
  // claim about artists nobody follows. A playlist maker is not one.
  if (!mounted || !artistCount) return null;

  const key = 'favpage:newmusic';
  const isCollapsed = collapsed.has(key);
  const stale = Date.now() - record.checkedAt >= CHECK_MIN_MS;
  const when = record.checkedAt ? fmtDate(Math.floor(record.checkedAt / 1000)) : null;
  const artists = `${artistCount} ${artistCount === 1 ? 'artist' : 'artists'}`;
  const followList = Object.values(follows).sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));

  return (
    <section className="mb-4" data-new-music>
      <CollapsibleHeading
        label={
          <span className="flex items-center gap-2">
            <span>NEW MUSIC</span>
            {visible.length > 0 && <span className="text-bolt">{visible.length}</span>}
            {phase === 'checking' && (
              <span className="text-muted normal-case">
                {progress.total > 1 ? `checking ${progress.done}/${progress.total}…` : 'checking…'}
              </span>
            )}
          </span>
        }
        collapsed={isCollapsed}
        onToggle={() => toggleCollapsed(key)}
        controls="fav-new-music-list"
        className="mb-2"
      />

      {/* The wrapper always renders, so `aria-controls` never dangles. */}
      <div id="fav-new-music-list" hidden={isCollapsed}>
        {!isCollapsed && (
          <>
            {/* WHERE THESE COME FROM, said once: following an artist is a ♡ on
                its publisher feed, which nothing else on the page explains. */}
            <p className="text-muted text-[11px] pb-2">New albums from the {artists} you follow.</p>

            {/* The artists followed with ♡ ARTIST, each with a way to stop.
                Device-only follows appear nowhere else on this page — the
                library lists the shared favorites — so without this a follow
                could only be undone from one of the artist's album pages. */}
            {followList.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pb-2" data-artist-follows>
                <span className="text-muted text-[11px]">Followed on this device:</span>
                {followList.map((f) => (
                  <span key={f.feedGuid} className="inline-flex items-center gap-1 border border-bone/20 pl-2 text-[11px]">
                    {f.title || 'Artist'}
                    <button
                      type="button"
                      onClick={() => setArtistFollow(npub, f, false)}
                      className="btn-ghost w-7 h-7 p-0 inline-flex items-center justify-center"
                      title="Stop following"
                      aria-label={`Stop following ${f.title || 'this artist'}`}
                    >
                      <span aria-hidden>✕</span>
                    </button>
                  </span>
                ))}
              </div>
            )}

            {phase === 'checking' && visible.length === 0 && (
              <p className="text-muted text-sm py-3">checking your artists for new albums…</p>
            )}

            {phase === 'done' && uncovered > 0 && (
              <p className="text-muted text-sm py-3">
                Could not check {uncovered} of your artists.{' '}
                <button type="button" onClick={() => void check(true)} className="btn-inline">
                  try again
                </button>
              </p>
            )}

            {phase === 'done' && visible.length === 0 && uncovered === 0 && (
              <p className="text-muted text-sm py-3">
                {deferred > 0
                  ? 'Nothing new from the artists checked.'
                  : `Nothing new${when ? ` since ${when}` : ''}.`}{' '}
                {deferred === 0 && stale && (
                  <button type="button" onClick={() => void check(true)} className="btn-inline">
                    check again
                  </button>
                )}
              </p>
            )}

            {phase === 'done' && deferred > 0 && (
              <p className="text-muted text-sm py-3">
                {deferred} more {deferred === 1 ? 'artist has' : 'artists have'} not been checked yet.{' '}
                <button type="button" onClick={() => void check(true)} className="btn-inline">
                  check the rest
                </button>
              </p>
            )}

            {!saved && (
              <p className="text-muted text-[11px] pb-2">
                This device could not remember what it showed you — these may come back.
              </p>
            )}

            {visible.length > 0 && (
              <ul className="space-y-2 md:space-y-0 md:grid md:grid-cols-2 md:gap-2">
                {visible.slice(0, shown).map((row) => {
                  const target = onOpen ? albumAsPodcast(row.album) : null;
                  const line = [
                    row.publisherTitle,
                    row.date ? fmtDate(row.date) : `found ${fmtDate(Math.floor(row.foundAt / 1000))}`,
                  ].filter(Boolean).join(' · ');
                  const body = (
                    <>
                      <PodcastCover
                        image={row.album.image}
                        artwork={row.album.artwork}
                        title={row.album.title}
                        seed={row.album.podcastGuid ?? String(row.album.id)}
                        className="w-12 h-12 sm:w-14 sm:h-14 flex-shrink-0"
                      />
                      <span className="min-w-0 flex-1 block">
                        <span data-new-music-title className="text-sm sm:text-base font-display leading-tight line-clamp-2 break-words">{row.album.title}</span>
                        <span className="text-[11px] sm:text-xs text-muted line-clamp-2 break-words sm:mt-0.5">{line}</span>
                      </span>
                    </>
                  );
                  return (
                    <li key={rowKey(row)} className="card flex items-center gap-2 p-3 lg:p-4">
                      {/* The cover and the text are ONE control to one
                          destination, as in NEW EPISODES. The handoff is the
                          page's (`openFeed`), so it stays in one place. */}
                      {target ? (
                        <button
                          type="button"
                          onClick={() => onOpen!(target)}
                          className="min-w-0 flex-1 flex items-center gap-3 text-left"
                        >
                          {body}
                        </button>
                      ) : (
                        <div className="min-w-0 flex-1 flex items-center gap-3">{body}</div>
                      )}
                      <button
                        type="button"
                        onClick={() => dismissRow(row)}
                        className="btn-ghost w-9 h-9 p-0 flex-shrink-0 inline-flex items-center justify-center"
                        title="Remove from new music"
                        aria-label={`Remove ${row.album.title} from new music`}
                      >
                        <span aria-hidden>✕</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {visible.length > 0 && (
              <div className="flex gap-2 mt-2">
                {visible.length > shown && (
                  <button
                    type="button"
                    onClick={() => setShown((n) => n + PAGE)}
                    className="btn-ghost flex-1 md:flex-none md:px-8 text-xs"
                  >
                    SHOW MORE ({visible.length - shown})
                  </button>
                )}
                <button
                  type="button"
                  onClick={clearRows}
                  className={`btn-ghost text-xs ${visible.length > shown ? '' : 'w-full md:w-auto md:px-8'}`}
                >
                  CLEAR
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
