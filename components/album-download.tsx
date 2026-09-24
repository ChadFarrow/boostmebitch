'use client';
import { useState } from 'react';
import type { Episode, Podcast } from '@/lib/types';
import { fmtBytes } from '@/lib/format';
import { downloadManager } from '@/lib/downloads/download-manager';
import { useDownloadsVersion } from '@/lib/downloads/use-downloads';

/**
 * DOWNLOAD ALBUM: every track of a music album in one decision.
 *
 * Asked for from an iPhone on Tinderbox (14 tracks, 43 MB): *"There should be an
 * option to download an entire album."* Bulk download was left out of the first
 * version on purpose, because it "spends the listener's data without a screen in
 * front of them". This control is built around that reason rather than against
 * it:
 *
 * - **The total is on the control before the first press**, from the same
 *   `planAlbum` the press queues from — one plan, so the number agreed to and
 *   the files fetched cannot disagree. Tracks already on the device are not in
 *   it, and a size the feed does not state is shown as `+`, never as nothing.
 * - **The first press spends nothing.** It asks, in a sentence with the count
 *   and the size, and only the second press queues. A mis-tap on a phone costs
 *   a sentence, not 43 MB.
 * - **It is not a new download path.** Each track goes through the same
 *   one-at-a-time queue as its own row's button, so nothing here can starve the
 *   episode playing right now.
 *
 * **Albums only — `music`, never a playlist and never a podcast.** An album is a
 * bounded, finished set that someone plausibly wants whole. A `musicL` playlist
 * is paged, so "the whole thing" is not known to this screen, and its tracks
 * live in other feeds. A podcast feed can be hundreds of episodes at ~160 MB
 * each, where "download everything" is a way to fill a phone.
 *
 * **STOP is not CANCEL, and the two words stay apart.** CANCEL answers the
 * question and nothing has been spent. STOP halts downloads in progress and
 * KEEPS what already finished — deleting a finished track is its own decision,
 * with its own control on every row.
 *
 * → docs/downloads.md, "Downloading an album"
 */
export function AlbumDownload({ episodes, podcast }: { episodes: Episode[]; podcast: Podcast }) {
  // A re-render trigger; everything below is read fresh off the manager.
  useDownloadsVersion();
  const [confirming, setConfirming] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  // BEFORE HYDRATION EVERY TRACK READS AS NOT DOWNLOADED, so this would offer
  // the whole album's size over an album that is already on the device, and
  // then correct itself. The rule <FavoritesPage> learned: a claim waits for the
  // read that supports it.
  if (!downloadManager.ready()) return null;

  const plan = downloadManager.planAlbum(episodes);
  // One track is not an album, and its row already has the control.
  if (plan.total < 2) return null;

  const known = fmtBytes(plan.knownBytes);
  // `+` when some tracks state no size: the real total is larger than the
  // number, and saying so is the difference between a hint and a promise.
  const sizeText = known ? `${known}${plan.unknownSize ? '+' : ''}` : null;

  // Failures are read off each track's own state, which is where the engine
  // puts them — the same message that track's button shows.
  const failed = episodes
    .map((e) => downloadManager.getEpisodeState(e))
    .filter((s) => s.status === 'error');

  const failure = failed.length > 0 && (
    <p role="alert" className="basis-full text-[11px] leading-tight text-red-400">
      {failed.length === 1 ? '1 track' : `${failed.length} tracks`} could not download
      {failed[0].error ? `: ${failed[0].error}` : '.'}
    </p>
  );

  if (plan.done === plan.total) {
    return (
      <span className="text-[11px] font-mono uppercase tracking-wider text-muted">
        ✓ All {plan.total} tracks downloaded
      </span>
    );
  }

  if (plan.active > 0) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        {/* `aria-live` so the count is announced as it moves; the visible text
            is the same sentence, so nothing is said that is not shown. */}
        <span aria-live="polite" className="text-[11px] font-mono uppercase tracking-wider text-bone/80 tabular-nums">
          <span aria-hidden className="animate-bolt">↓</span> Album: {plan.done} of {plan.total} downloaded
        </span>
        <button
          type="button"
          className="btn-mini"
          onClick={() => downloadManager.cancelAlbum(episodes)}
          title="Stop downloading this album. Tracks already downloaded stay."
        >
          STOP
        </button>
        {failure}
      </span>
    );
  }

  const count = plan.fetch.length;
  const tracks = count === 1 ? '1 track' : `${count} tracks`;

  if (confirming) {
    return (
      // The question takes a LINE of its own and the two answers sit together
      // under it. Left to wrap inline at 390px, CANCEL fell onto a third line by
      // itself, away from the DOWNLOAD it is the alternative to.
      <span className="flex basis-full flex-wrap items-center gap-2">
        <span className="basis-full text-xs text-bone">
          Download {plan.done > 0 ? `the ${tracks} not on this device` : tracks}
          {sizeText ? ` (${sizeText})` : ''}?
          {plan.unknownSize > 0 && (
            <span className="text-muted">
              {' '}{plan.unknownSize === count ? 'The feed states no size for them.' : `${plan.unknownSize} state no size.`}
            </span>
          )}
        </span>
        <button
          type="button"
          className="btn-mini border-bone text-bone"
          onClick={async () => {
            setConfirming(false);
            const r = await downloadManager.downloadAlbum(episodes, podcast);
            if (r === 'no-room') {
              setRefused(`Not enough space for this album${sizeText ? ` (${sizeText})` : ''} — remove a download to make room.`);
            }
          }}
        >
          DOWNLOAD
        </button>
        <button type="button" className="btn-mini" onClick={() => setConfirming(false)}>
          CANCEL
        </button>
      </span>
    );
  }

  const label = `Download ${plan.done > 0 ? `the ${tracks} of this album not on this device` : `the whole album, ${tracks}`}`
    + `${sizeText ? `, ${sizeText}` : ''}`;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn-mini"
        aria-label={label}
        title={label}
        onClick={() => { setRefused(null); setConfirming(true); }}
      >
        <span aria-hidden>↓</span>
        {/* "11 MORE", not "REST": the count is the fact, and a half-downloaded
            album is exactly when the listener needs it. */}
        {plan.done > 0 ? `DOWNLOAD ${count} MORE` : 'DOWNLOAD ALBUM'}
        {sizeText && <span className="tabular-nums opacity-70">{sizeText}</span>}
      </button>
      {refused && (
        <p role="alert" className="basis-full text-[11px] leading-tight text-red-400">{refused}</p>
      )}
      {failure}
    </span>
  );
}
