'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clearShowSelection, useApp } from '@/lib/store';
import { fmt, fmtBytes, timeAgo } from '@/lib/format';
import { downloadManager } from '@/lib/downloads/download-manager';
import { useDownloadsVersion } from '@/lib/downloads/use-downloads';
import { dbRowToEpisode, dbRowToPodcast, type DownloadRecord } from '@/lib/downloads/downloads-db';
import { estimateUsage } from '@/lib/downloads/downloads-cache';
import { groupDownloads } from '@/lib/downloads/download-rules';
import { PodcastCover } from '@/components/podcast-cover';

/**
 * The download library at `/downloads`.
 *
 * It is the only place the total size is visible, and the only way to reach a
 * download again without finding its episode — which is why "just the row
 * buttons" was not an option.
 *
 * PLAYING A ROW DOES NOT NAVIGATE. `<Player>` is mounted in the root layout, so
 * `play()` from here starts the audio in place and the mini-player appears over
 * this list. Opening the SHOW is the one thing that needs the handoff, and it is
 * the same one `<FavoritesPage>` documents: set the store, then `router.push('/')`
 * — never `router.push('/?podcast=…')`, because `<HomePage>`'s restore effect
 * early-returns whenever a selection is already set, so a visitor who opened any
 * show earlier in the session would land back on that one.
 *
 * A SHOW WITH TWO OR MORE DOWNLOADS IS ONE ENTRY THAT OPENS (`<ShowGroup>`).
 * Asked for from an iPhone after the first DOWNLOAD ALBUM put fourteen
 * Tinderbox rows on this page. `groupDownloads` (download-rules.ts, pinned by
 * check:downloads) decides the entries and both orders; this file only renders
 * them. A group starts CLOSED — that is the point of it.
 */

const DOWNLOADS_ORIGIN = { path: '/downloads', label: 'downloads' };

export function DownloadsPage() {
  useDownloadsVersion();
  const router = useRouter();
  const play = useApp((s) => s.play);
  const selectPodcast = useApp((s) => s.selectPodcast);
  const setShowOrigin = useApp((s) => s.setShowOrigin);
  const currentEpisode = useApp((s) => s.current?.episode);

  const ready = downloadManager.ready();
  const rows = downloadManager.listDownloads();
  const total = downloadManager.totalBytes();
  const currentKey = downloadManager.storedKeyFor(currentEpisode);

  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null);
  const refreshQuota = useCallback(() => { void estimateUsage().then(setQuota); }, []);
  // Re-read whenever the library changes, so deleting something is reflected in
  // the device figure rather than only in our own total.
  useEffect(refreshQuota, [refreshQuota, rows.length]);

  const [confirmClear, setConfirmClear] = useState(false);

  /**
   * Covers rendered from the bytes stored with each download.
   *
   * `/downloads` is the ONE surface that has to paint art with no network —
   * everywhere else a cover goes through `/api/art`, which is a request. The
   * blob URLs are revoked when the set changes and on unmount; a leaked one pins
   * its image for the life of the document.
   *
   * A miss just leaves `<PodcastCover>` to its normal ladder, which is right:
   * with a connection it fetches, and without one it falls through to the
   * generated placeholder rather than a broken image.
   */
  const [covers, setCovers] = useState<Record<string, string>>({});
  const keys = rows.map((r) => r.key).join('\u0000');
  useEffect(() => {
    let cancelled = false;
    const made: string[] = [];
    void Promise.all(
      keys.split('\u0000').filter(Boolean).map(async (k) => {
        const url = await downloadManager.coverUrlFor(k);
        if (url) made.push(url);
        return [k, url] as const;
      }),
    ).then((pairs) => {
      if (cancelled) {
        made.forEach((u) => URL.revokeObjectURL(u));
        return;
      }
      setCovers(Object.fromEntries(pairs.filter((p): p is readonly [string, string] => !!p[1])));
    });
    return () => {
      cancelled = true;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [keys]);

  function openShow(r: DownloadRecord) {
    selectPodcast(dbRowToPodcast(r));
    // AFTER selectPodcast — that action clears `showOrigin`, so setting it first
    // would be undone without the caller knowing the field exists.
    setShowOrigin(DOWNLOADS_ORIGIN);
    router.push('/');
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="headline text-2xl sm:text-5xl">Downloads</h1>
          <p className="mt-1 font-mono text-xs text-muted">
            {/* AN EMPTY LIBRARY IS A CLAIM, and it may only be made once the read
                has answered. <FavoritesPage> shipped saying "Nothing saved yet."
                over a full library because it had no in-flight state, and it
                self-corrected a moment later — which is what made it worse. */}
            {!ready
              ? 'Reading your downloads…'
              : rows.length === 0
                ? 'Nothing downloaded yet'
                // "downloads", not "episodes": an album's are tracks.
                : `${rows.length} download${rows.length === 1 ? '' : 's'} · ${fmtBytes(total) ?? '—'}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* The store outlives a route change on purpose, so a plain link Home
              would re-open whatever show this visitor had open last. */}
          <Link href="/" onClick={clearShowSelection} className="btn-ghost text-xs">
            ← HOME
          </Link>
          {ready && rows.length > 0 && (
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => (confirmClear ? void downloadManager.clearAll().then(() => setConfirmClear(false)) : setConfirmClear(true))}
            >
              {/* An inline two-press confirm rather than window.confirm: this is
                  the one control here that destroys everything, and a native
                  dialog in the installed PWA is a system sheet over the app. */}
              {confirmClear ? 'REALLY DELETE ALL?' : 'DELETE ALL'}
            </button>
          )}
        </div>
      </header>

      {quota && (
        <p className="font-mono text-[11px] text-muted">
          {fmtBytes(quota.usage) ?? '0 B'} of {fmtBytes(quota.quota) ?? '—'} used on this device
        </p>
      )}

      {ready && rows.length === 0 && (
        <p className="max-w-prose text-sm text-muted">
          Press <span className="font-mono">DOWNLOAD</span> on any episode to keep it here. A
          downloaded episode plays without using data, which is what this is for on a slow or
          metered connection.
        </p>
      )}

      {/* Two columns from lg:, `items-start` so an opened <ShowGroup> grows
          alone instead of stretching the card beside it. */}
      <ul className="space-y-2 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-3 lg:items-start">
        {groupDownloads(rows).map((item) =>
          item.kind === 'one' ? (
            <DownloadRow
              key={item.record.key}
              r={item.record}
              cover={covers[item.record.key]}
              isCurrent={currentKey === item.record.key}
              onPlay={play}
              onShow={openShow}
            />
          ) : (
            <ShowGroup
              key={item.id}
              records={item.records}
              covers={covers}
              currentKey={currentKey}
              onPlay={play}
              onShow={openShow}
            />
          ),
        )}
      </ul>

      {ready && rows.length > 0 && (
        // Eviction is expected rather than exceptional, and saying so here is
        // cheaper than a support conversation. iOS drops an origin's storage
        // under pressure without telling anyone; `requestPersistence()` asks not
        // to be and Safari does not grant it.
        <p className="max-w-prose font-mono text-[11px] leading-relaxed text-muted">
          On iPhone and iPad the browser can remove downloads to free space. If one disappears,
          the episode simply streams again the next time you play it.
        </p>
      )}
    </div>
  );
}

type Play = ReturnType<typeof useApp.getState>['play'];

/**
 * One download. On its own it is a card with SHOW and DELETE; inside a
 * `<ShowGroup>` (`nested`) it drops the card, the show's name and SHOW, which
 * the group already carries once — and the title gets that width back.
 */
function DownloadRow({
  r,
  cover,
  isCurrent,
  onPlay,
  onShow,
  nested = false,
}: {
  r: DownloadRecord;
  cover: string | undefined;
  isCurrent: boolean;
  onPlay: Play;
  onShow: (r: DownloadRecord) => void;
  nested?: boolean;
}) {
  return (
    <li
      className={
        nested
          ? `flex items-center gap-3 py-2 pl-2 border-l-2 ${isCurrent ? 'border-bolt' : 'border-transparent'}`
          : `card flex items-center gap-3 p-3 lg:p-4 ${isCurrent ? 'border-bolt/60' : ''}`
      }
    >
      <button
        type="button"
        onClick={() => onPlay(dbRowToEpisode(r), dbRowToPodcast(r))}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        aria-label={`Play ${r.title}`}
      >
        {/* THE STORED COVER IS PASSED ALONE, with no `artwork` beside it.
            `artCandidates` puts every PROXIED url ahead of every raw one, and a
            `blob:` is not proxyable — so passing both would order the network
            copy of the artwork FIRST and leave the local bytes as its fallback,
            which is backwards on the one surface that has to paint with no
            connection. With no download the normal pair is passed — PI's
            `image` and `artwork` often disagree, and the ladder needs both. */}
        <PodcastCover
          image={cover ?? r.image}
          artwork={cover ? undefined : r.feedImage}
          title={r.title}
          seed={r.key}
          className={`${nested ? 'w-10 h-10 sm:w-12 sm:h-12' : 'w-12 h-12 sm:w-14 sm:h-14'} flex-shrink-0`}
          w={160}
        />
        <span className="min-w-0">
          <span className="block truncate text-sm sm:text-base">{r.title}</span>
          <span className="block truncate font-mono text-[11px] sm:text-xs text-muted">
            {[nested ? null : r.feedTitle, fmtBytes(r.sizeBytes), r.duration ? fmt(r.duration) : null, timeAgo(r.createdAt / 1000)]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
      </button>
      <div className="flex flex-shrink-0 items-center gap-2">
        {!nested && r.feedGuid && (
          <button type="button" onClick={() => onShow(r)} className="btn-ghost text-[11px] sm:text-xs">
            SHOW
          </button>
        )}
        {/* DELETE IS BY KEY, and that is not a detail. A download whose feed
            moved its enclosure URL and which carries no item guid is orphaned —
            nothing can match it to an episode any more — so deleting it from a
            row is the only way those bytes ever come back. Every row inside a
            group keeps its own, for the same reason. */}
        <button
          type="button"
          onClick={() => void downloadManager.remove(r.key)}
          className="btn-ghost text-[11px] sm:text-xs"
          aria-label={`Delete the download of ${r.title}`}
        >
          DELETE
        </button>
      </div>
    </li>
  );
}

/**
 * A show's downloads as one entry: its name, how many, how much, and a press
 * that opens it.
 *
 * **It starts CLOSED**, which is the whole request — fourteen rows reading
 * "Tinderbox" were pushing every other download off a phone screen. The state
 * is not persisted: a group re-closes on the next visit, and the page opens on
 * one line per show every time.
 *
 * **The group's DELETE asks first, in a sentence with the count and the size.**
 * A row's DELETE removes one file and does not ask; this removes a whole album
 * with one press, so it takes the same two-step shape as DOWNLOAD ALBUM on the
 * way in, and CANCEL means the same thing it means there: nothing has happened.
 *
 * **The border marks the group holding what is playing**, so a closed group
 * still says where the current track is. Inside, the row carries it.
 */
function ShowGroup({
  records,
  covers,
  currentKey,
  onPlay,
  onShow,
}: {
  records: DownloadRecord[];
  covers: Record<string, string>;
  currentKey: string | null;
  onPlay: Play;
  onShow: (r: DownloadRecord) => void;
}) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const listId = useId();
  const first = records[0];
  const name = records.find((r) => r.feedTitle)?.feedTitle ?? first.title;
  const size = fmtBytes(records.reduce((n, r) => n + (r.sizeBytes || 0), 0));
  const count = `${records.length} downloaded`;
  const holdsCurrent = records.some((r) => r.key === currentKey);
  // The stored cover of any member: an album's tracks share their art, and a
  // group must paint offline exactly as its rows do.
  const cover = records.map((r) => covers[r.key]).find(Boolean);

  return (
    <li className={`card p-3 lg:p-4 ${holdsCurrent ? 'border-bolt/60' : ''}`}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={listId}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <PodcastCover
            image={cover ?? first.feedImage ?? first.image}
            artwork={cover ? undefined : first.image}
            title={name}
            seed={first.feedGuid ?? first.key}
            className="w-12 h-12 sm:w-14 sm:h-14 flex-shrink-0"
            w={160}
          />
          <span className="min-w-0">
            {/* The disclosure arrow LEADS the name, the way a <details> summary
                draws it. At the end of the line it took a column of its own out
                of ~115px, and the size below was what paid for it. */}
            <span className="flex min-w-0 items-baseline gap-1.5 text-sm sm:text-base">
              <span aria-hidden className="flex-shrink-0 font-mono text-muted">{open ? '▾' : '▸'}</span>
              <span className="truncate">{name}</span>
            </span>
            {/* WRAPS, NOT TRUNCATES — the episode row's rule, for its reason: a
                truncate here ate "17 MB" at 390px, and the size is the number
                someone reads before pressing DELETE on a whole album. */}
            <span className="flex flex-wrap gap-x-2 font-mono text-[11px] sm:text-xs text-muted">
              <span className="whitespace-nowrap">{count}</span>
              {size && <span className="whitespace-nowrap">{size}</span>}
            </span>
          </span>
        </button>
        <div className="flex flex-shrink-0 items-center gap-2">
          {first.feedGuid && (
            <button type="button" onClick={() => onShow(first)} className="btn-ghost text-[11px] sm:text-xs">
              SHOW
            </button>
          )}
          <button
            type="button"
            onClick={() => setAsking(true)}
            className="btn-ghost text-[11px] sm:text-xs"
            aria-label={`Delete all ${records.length} downloads of ${name}`}
          >
            DELETE
          </button>
        </div>
      </div>
      {asking && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="basis-full text-xs text-bone">
            Delete {records.length} downloads{size ? ` (${size})` : ''}? They stream again when you play them.
          </span>
          <button
            type="button"
            className="btn-mini border-bone text-bone"
            onClick={() => {
              setAsking(false);
              // By KEY, each one — the same call a row's DELETE makes.
              void Promise.all(records.map((r) => downloadManager.remove(r.key)));
            }}
          >
            {/* "DELETE 14", not "DELETE". With the question open, three buttons
                on this screen would otherwise read DELETE — this one, the
                group's own, and the next row's — and the one that removes an
                album is the one that must not be mistaken. */}
            DELETE {records.length}
          </button>
          <button type="button" className="btn-mini" onClick={() => setAsking(false)}>
            CANCEL
          </button>
        </div>
      )}
      {open && (
        <ul id={listId} className="mt-3 border-t border-bone/10 pt-1">
          {records.map((r) => (
            <DownloadRow
              key={r.key}
              r={r}
              cover={covers[r.key]}
              isCurrent={currentKey === r.key}
              onPlay={onPlay}
              onShow={onShow}
              nested
            />
          ))}
        </ul>
      )}
    </li>
  );
}
