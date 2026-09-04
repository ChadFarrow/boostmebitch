'use client';

import { useEffect, useState } from 'react';
import type { Episode } from '@/lib/types';
import { livePlayedKey, livePlayedSnapshot, subscribeLivePlayed, type PlayedTrack } from '@/lib/live-played';
import { useApp } from '@/lib/store';
import { liveTargetSnapshot, subscribeLiveTarget } from '@/lib/v4v/live-value';
import { splitTargetLabel } from './live-now-playing';
import { FavTrackHeart } from './fav-heart';
import { RowThumb } from './chapter-ui';
import { fmtClock } from '@/lib/format';

/**
 * The songs a live show has played, newest first, each one favoritable.
 *
 * **This is the live twin of `<EpisodeContents>`,** and it exists because the
 * two shows are not the same shape. A finished episode publishes its whole
 * timeline, so every `<podcast:valueTimeSplit>` window can be listed with a
 * heart on it from the moment the page loads. A live show hands over one block
 * at a time and keeps nothing: before this, the only instant a listener could
 * favorite a live track was while it was on air, and only if they happened to
 * be looking at the screen. `lib/live-played.ts` remembers the blocks as they
 * go by; this renders them.
 *
 * **Rows are not seek buttons.** That is the other half of the same difference:
 * a live stream has no timeline to jump within, which is why the fullscreen
 * player replaces its seek bar with a ● LIVE stamp. So a row carries the clock
 * time the block went on air instead of an offset, and nothing here is
 * clickable except the heart.
 *
 * **The heart is `<FavTrackHeart>`, unchanged.** A live block is normalized
 * into the same synthetic `ValueTimeSplit` every other signal is, so the
 * favorite it writes is byte-for-byte the one the artist's own album page would
 * write — same `remoteItem`, same kind:10333 entry, same refusal when the block
 * names no resolvable parent feed. Nothing about the show doing the playing is
 * recorded, and nothing should be: a song is a song wherever it was heard.
 *
 * **A row waits for its parent-feed verdict before offering that heart.** A
 * socket block is built client-side and reaches the log with `parentFeedGuid`
 * still `undefined`, which reads as "the wire guid stands" and is exactly what
 * a host pointing `feedGuid` at a PUBLISHER feed also looks like. The log
 * resolves it and flips `PlayedTrack.parentResolved`; until then there is no
 * control to press. A failed lookup flips it too — see there.
 *
 * Renders nothing at all unless this item is the one being logged, so it is
 * safe to place unconditionally beside an ordinary episode's panels.
 */
export function LivePlayedTracks({
  episode,
  fallbackImg,
  className = '',
}: {
  episode?: Episode;
  /** The show's own art, for a block that ships none — the same one-left-edge
   *  argument `<RowThumb>` carries. */
  fallbackImg?: string;
  className?: string;
}) {
  const guid = episode?.guid;
  const [played, setPlayed] = useState<PlayedTrack[]>(() => livePlayedSnapshot(guid));
  // Re-reads on mount as well as on every change: the log is a module singleton
  // that has usually been filling since before this component existed, and the
  // useState initialiser only runs once per mount, not once per `guid`.
  useEffect(() => {
    setPlayed(livePlayedSnapshot(guid));
    return subscribeLivePlayed(() => setPlayed(livePlayedSnapshot(guid)));
  }, [guid]);

  // Which row is on air. Read from the watcher rather than from the log's own
  // tail, because the current target is not always in the log — the show's
  // default block between two songs is deliberately never recorded, and while
  // it is up NO row should claim to be playing.
  const [target, setTarget] = useState(liveTargetSnapshot);
  useEffect(() => subscribeLiveTarget(() => setTarget(liveTargetSnapshot())), []);

  // Feed-supplied artwork must never outrank the enclosure, and this list is
  // behind no tab: it is the first thing in the fullscreen player's scroll body
  // and it sits above the episode page's tabs, so <RowThumb>'s lazy/low/async —
  // "the whole mitigation" only for a list someone has to open — is not enough
  // on its own. <Player> publishes the same one verdict both art surfaces use.
  // The show's own art still renders, so a row keeps its left edge.
  const artOk = useApp((s) => s.artOk);

  if (!guid || !played.length) return null;
  // Derived through the log's own key function, never off `bucketKey` directly:
  // the two must agree about what makes a row, or the marker sits on no row.
  const nowKey = target?.guid === guid ? livePlayedKey(target) : '';
  // Newest first: on a three-hour set the song someone wants is the one that
  // just finished, and a list that grows downward would push it off the screen.
  const rows = [...played].reverse();

  return (
    <div className={className}>
      <p className="text-[11px] uppercase tracking-widest text-muted mb-2">
        Played so far · {rows.length}
      </p>
      <ul className="text-xs">
        {rows.map((p) => {
          const on = p.key === nowKey;
          return (
            // No negative horizontal margin on this row, however much the
            // on-air highlight wants to bleed past the text. Both hosts put
            // this list inside a scroll body that is `overflow-y-auto`, and CSS
            // computes the OTHER axis of such a box to `auto` as well — so a
            // row 16px wider than its container paints a horizontal scrollbar
            // across the whole panel, on a list that has nothing to scroll
            // sideways to. The chapter rows in <FullscreenPlayer> get away with
            // `-mx-2` because their own <ul> carries the matching `pr-2`; this
            // list does not own its scroll container and cannot pad it.
            <li
              key={p.key}
              className={`flex items-center gap-1 rounded ${on ? 'bg-bolt/10' : ''}`}
            >
              <div className="flex-1 min-w-0 flex gap-3 items-center py-1.5">
                <RowThumb
                  src={artOk ? p.split.image : undefined}
                  fallback={fallbackImg}
                  className="w-9 h-9 rounded object-cover flex-shrink-0 border border-bone/15"
                />
                <span className="min-w-0 flex-1">
                  <span className={`block truncate ${on ? 'text-bolt' : 'text-bone/80'}`}>
                    {/* A block with neither a title nor a named payee is still
                        worth a row — it is a song someone heard — so it says so
                        rather than rendering an empty line. */}
                    {splitTargetLabel(p.split, 'Untitled track')}
                  </span>
                  <span className="block text-[10px] text-muted">
                    {on ? '● on air now' : fmtClock(Math.floor(p.atMs / 1000))}
                  </span>
                </span>
              </div>
              {/* Waits for the parent-feed verdict on a socket block, then
                  declines on its own for a block that names no track — a host
                  segment, or a song whose parent feed can never resolve. */}
              <div className="flex-shrink-0 pr-1">
                {p.parentResolved && <FavTrackHeart split={p.split} />}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
