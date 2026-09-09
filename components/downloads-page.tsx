'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clearShowSelection, useApp } from '@/lib/store';
import { fmt, fmtBytes, timeAgo } from '@/lib/format';
import { downloadManager } from '@/lib/downloads/download-manager';
import { useDownloadsVersion } from '@/lib/downloads/use-downloads';
import { dbRowToEpisode, dbRowToPodcast, type DownloadRecord } from '@/lib/downloads/downloads-db';
import { estimateUsage } from '@/lib/downloads/downloads-cache';
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
          <h1 className="headline text-2xl">Downloads</h1>
          <p className="mt-1 font-mono text-xs text-muted">
            {/* AN EMPTY LIBRARY IS A CLAIM, and it may only be made once the read
                has answered. <FavoritesPage> shipped saying "Nothing saved yet."
                over a full library because it had no in-flight state, and it
                self-corrected a moment later — which is what made it worse. */}
            {!ready
              ? 'Reading your downloads…'
              : rows.length === 0
                ? 'Nothing downloaded yet'
                : `${rows.length} episode${rows.length === 1 ? '' : 's'} · ${fmtBytes(total) ?? '—'}`}
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

      <ul className="space-y-2">
        {rows.map((r) => {
          const isCurrent = downloadManager.keyFor(currentEpisode) === r.key;
          return (
            <li key={r.key} className={`card flex items-center gap-3 p-3 ${isCurrent ? 'border-bolt/60' : ''}`}>
              <button
                type="button"
                onClick={() => play(dbRowToEpisode(r), dbRowToPodcast(r))}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                aria-label={`Play ${r.title}`}
              >
                {/* Both sources, always — PI's `image` and `artwork` often
                    disagree and <PodcastCover>'s onError ladder needs the pair. */}
                {/* THE STORED COVER IS PASSED ALONE, with no `artwork` beside
                    it. `artCandidates` puts every PROXIED url ahead of every raw
                    one, and a `blob:` is not proxyable — so passing both would
                    order the network copy of the artwork FIRST and leave the
                    local bytes as its fallback, which is backwards on the one
                    surface that has to paint with no connection. With no
                    download the normal pair is passed and the normal ladder
                    applies. */}
                <PodcastCover
                  image={covers[r.key] ?? r.image}
                  artwork={covers[r.key] ? undefined : r.feedImage}
                  title={r.title}
                  seed={r.key}
                  className="w-12 h-12 flex-shrink-0"
                  w={160}
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm">{r.title}</span>
                  <span className="block truncate font-mono text-[11px] text-muted">
                    {[r.feedTitle, fmtBytes(r.sizeBytes), r.duration ? fmt(r.duration) : null, timeAgo(r.createdAt / 1000)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </button>
              <div className="flex flex-shrink-0 items-center gap-2">
                {r.feedGuid && (
                  <button type="button" onClick={() => openShow(r)} className="btn-ghost text-[11px]">
                    SHOW
                  </button>
                )}
                {/* DELETE IS BY KEY, and that is not a detail. A download whose
                    feed moved its enclosure URL and which carries no item guid is
                    orphaned — nothing can match it to an episode any more — so
                    deleting it from a row is the only way those bytes ever come
                    back. */}
                <button
                  type="button"
                  onClick={() => void downloadManager.remove(r.key)}
                  className="btn-ghost text-[11px]"
                  aria-label={`Delete the download of ${r.title}`}
                >
                  DELETE
                </button>
              </div>
            </li>
          );
        })}
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
