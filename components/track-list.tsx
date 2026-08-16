'use client';
import { fmt } from '@/lib/format';
import { splitAtPosition } from '@/lib/util';
import type { ValueTimeSplit } from '@/lib/types';
import { RowThumb } from './chapter-ui';
import { FavTrackHeart } from './fav-heart';

/**
 * The tracks a show played, one row per `<podcast:valueTimeSplit>` window:
 * seek to it, and favorite it.
 *
 * **Driven by the windows, never by the chapters.** The two lists look alike on
 * screen and are not the same thing — see the note on `useResolvedSplits`
 * (`lib/track-art.ts`) for the measurements. Short version: chapters are the
 * host's illustration of the audio and include their own talk breaks, they tie
 * and overlap against the windows on real feeds, and plenty of shows publish
 * windows with no chapters JSON at all. The window is the authoritative one —
 * it decides who a boost pays, and it is the only one of the two carrying the
 * `feedGuid`/`itemGuid` pair a favorite has to record.
 *
 * The favorite that writes points at the artist's release rather than at this
 * episode, so it is the same entry the album page would produce. See
 * `<FavTrackHeart>`.
 *
 * **The heart is a sibling of the seek button, not a child of it.** Same reason
 * the chapter lists hang their `↗` link outside: a button inside a button is
 * invalid HTML and browsers reparent it, which drops the row's click target on
 * the floor. `<FavTrackHeart>` stops propagation of its own accord anyway —
 * belt and braces, since it is also used where the row *is* clickable.
 *
 * `currentSec` highlights the playing row through the same `splitAtPosition`
 * the payment path uses, so the highlight and the payee can't disagree.
 *
 * **Omit it where this episode isn't the one playing — don't pass 0.** 0 is a
 * real position, and `splitAtPosition`'s interval is half-open `[start, …)`, so
 * a window authored at `startTime: 0` — the norm on a Split Kit playlist that
 * opens straight on a track — MATCHES it. Passing 0 to mean "not playing"
 * therefore lit the first row as the playing track on a show nobody had
 * started, which is the one claim this highlight exists to make truthfully.
 * `undefined` says "inactive" without competing for a value the data can hold.
 */
export function TrackList({
  splits,
  currentSec,
  onSeek,
  fallbackImg,
  className = '',
}: {
  splits: ValueTimeSplit[];
  /** Playback position in seconds, or undefined when this episode is not the
   *  one playing. See the note above — undefined, never 0. */
  currentSec?: number;
  onSeek: (t: number) => void;
  /** The episode's own art, for a window whose remote item never resolved —
   *  same one-left-edge argument as the chapter lists' `fallbackImg`. */
  fallbackImg?: string;
  className?: string;
}) {
  // Identity comparison, not an index: `splitAtPosition` returns an element of
  // this very array, and re-deriving "which index is active" with a second rule
  // is how a highlight comes to name a different track than the boost would.
  // The undefined check comes FIRST — handing 0 to splitAtPosition is exactly
  // the bug the prop's doc describes.
  const active = currentSec === undefined ? null : splitAtPosition(splits, currentSec);

  return (
    <ul className={`text-xs ${className}`}>
      {splits.map((s, i) => {
        const on = s === active;
        return (
          <li
            key={`${s.startTime}-${s.remoteItem?.itemGuid ?? i}`}
            className={`flex items-center gap-1 rounded -mx-2 transition ${on ? 'bg-bolt/10' : ''}`}
          >
            <button
              type="button"
              onClick={() => onSeek(s.startTime)}
              title={`Jump to ${fmt(s.startTime)}`}
              className={`flex-1 min-w-0 flex gap-3 items-center text-left rounded transition py-1.5 px-2 ${
                on ? 'text-bolt' : 'text-bone/80 hover:bg-bone/5'
              }`}
            >
              <RowThumb
                src={s.image}
                fallback={fallbackImg}
                className="w-9 h-9 rounded object-cover flex-shrink-0 border border-bone/15"
              />
              <span className={`tabular-nums w-12 flex-shrink-0 ${on ? 'text-bolt' : 'text-muted'}`}>
                {fmt(s.startTime)}
              </span>
              {/* An unresolved window is ordinary, not an error — Podcast Index
                  hasn't crawled every album feed — so it says so plainly and
                  keeps its heart. The identifiers are what a favorite records;
                  the title is what resolution adds. */}
              <span className={`break-words min-w-0 ${s.title ? '' : 'text-muted italic'}`}>
                {s.title ?? 'Track not yet indexed'}
              </span>
            </button>
            <div className="flex-shrink-0 pr-1">
              <FavTrackHeart split={s} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
