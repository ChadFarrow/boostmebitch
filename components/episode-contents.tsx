'use client';
import { useMemo } from 'react';
import { fmt } from '@/lib/format';
import { mergeEpisodeContents, splitAtPosition, type EpisodeContentRow } from '@/lib/util';
import type { ChapterEntry, ValueTimeSplit } from '@/lib/types';
import { RowThumb } from './chapter-ui';
import { FavTrackHeart } from './fav-heart';
import { CopyLinkButton } from './copy-link-button';

/**
 * Everything an episode published about its own timeline, as ONE list: the
 * tracks it played (`<podcast:valueTimeSplit>` windows) and its chapters,
 * interleaved by timestamp. Seek from any row; favorite a track row.
 *
 * **This replaced two tabs sitting side by side.** Tracks and Chapters were
 * separate lists with near-identical rows — thumbnail, timestamp, title — and on
 * a music show they largely named the same songs, so the screen asked the
 * listener to understand a distinction that is ours, not theirs. Merging them is
 * a presentational change and deliberately nothing more.
 *
 * **The heart still rides on the WINDOW, and no chapter is ever mapped to one.**
 * That is the rule the old two-list arrangement existed to enforce, and it
 * survives here intact because the merge is by timestamp alone: a track row is
 * built from a window and carries that window; a chapter row is built from a
 * chapter and has no identifiers to offer. The two are distinct variants of
 * `EpisodeContentRow`, so a chapter row has no `split` to hand
 * `<FavTrackHeart>` even by accident. `mergeEpisodeContents` (`lib/util.ts`)
 * carries the measurements — including the three songs on Homegrown Hits 146
 * that "the window covering this chapter" would favorite as the wrong track,
 * because the windows overlap. `check:vts` pins it against the real wire.
 *
 * **The heart is a sibling of the seek button, not a child of it.** Same reason
 * a chapter row hangs its `↗` link outside: a button inside a button is invalid
 * HTML and browsers reparent it, which drops the row's click target on the
 * floor. `<FavTrackHeart>` stops propagation of its own accord anyway.
 *
 * **Exactly one row highlights, and a track row wins.** The two lists this
 * replaces each had their own rule and merging them naively lights two rows at
 * once. See `activeIdx` below.
 *
 * **Every row can be shared, chapter and track alike, and that is not a widened
 * scope — it is the merge rule showing through.** `mergeEpisodeContents` drops a
 * chapter that starts within 2 s of a window (14 of 31 on Homegrown Hits 146),
 * so a share button offered only on `kind === 'chapter'` rows would be missing
 * from exactly the moments a listener is most likely to want to send, with
 * nothing on screen explaining the gap. A timestamp is a property of the ROW,
 * not of which of the two sources produced it — unlike the heart, which needs
 * the window's identifiers and therefore genuinely cannot ride on a chapter.
 */
export function EpisodeContents({
  splits,
  chapters,
  currentSec,
  onSeek,
  shareUrlFor,
  fallbackImg,
  className = '',
}: {
  splits: ValueTimeSplit[] | null;
  chapters: ChapterEntry[] | null;
  /** Playback position in seconds, or undefined when this episode is not the
   *  one playing. See `activeIdx` — undefined, never 0. */
  currentSec?: number;
  onSeek: (t: number) => void;
  /**
   * Builds a share URL for a row's timestamp, or `null` when there is nothing
   * stable to link to. Omit it entirely and no row renders a share button.
   *
   * **URL building stays at the CALL SITE** — the rule `<CopyLinkButton>` is
   * built around, and here it is also what keeps this component free of
   * `episode`/`podcast` props it has never needed. The call site owes one
   * guard in return: `showShareUrl(guid, undefined, t)` returns a SHOW link, so
   * a surface whose episode has no guid must pass nothing rather than a builder
   * that quietly hands every row the same show link.
   */
  shareUrlFor?: (startSec: number) => string | null;
  /** The episode's own art, for a row that ships none — same one-left-edge
   *  argument as the chapter lists this replaces. */
  fallbackImg?: string;
  className?: string;
}) {
  const rows = useMemo(() => mergeEpisodeContents(splits, chapters), [splits, chapters]);

  /**
   * Which row reads as "you are here".
   *
   * **`undefined` means the episode isn't playing, and it is checked before any
   * position lookup. 0 is a real position and cannot also be a sentinel** —
   * `splitAtPosition`'s interval is half-open `[start, …)`, so 0 MATCHES a
   * window authored at `startTime: 0`, which is the norm on a Split Kit
   * playlist that opens straight on a track. Passing 0 to mean "not playing"
   * lit the first row as the playing track on a show nobody had started.
   *
   * **A window wins over a chapter**, and via `splitAtPosition` rather than
   * "the last row whose start has passed". Two reasons, both load-bearing:
   * a window carries a `duration` and can end before the next row begins, so
   * last-start-passed would go on claiming a song is playing after it stopped;
   * and `splitAtPosition` is the same function the boost modal and
   * `lib/v4v/streaming.ts` consult, so the highlighted track row is by
   * construction the one a boost pressed right now would pay. A second rule
   * here is how the highlight comes to name a different artist than the wallet.
   *
   * Only when no window covers this second does a chapter row light up — the
   * last one whose start has passed, which is the ordinary chapter rule.
   */
  const activeIdx = useMemo(() => {
    if (currentSec === undefined) return -1;
    const active = splitAtPosition(splits, currentSec);
    if (active) return rows.findIndex((r) => r.kind === 'track' && r.split === active);
    return rows.reduce(
      (acc, r, i) => (r.kind === 'chapter' && r.startTime <= currentSec ? i : acc),
      -1,
    );
  }, [rows, splits, currentSec]);

  if (!rows.length) return null;

  return (
    <ul className={`text-xs ${className}`}>
      {rows.map((row, i) => {
        const on = i === activeIdx;
        return (
          <li
            key={
              row.kind === 'track'
                ? `t-${row.startTime}-${row.split.remoteItem?.itemGuid ?? i}`
                : `c-${row.startTime}-${row.chapter.title ?? i}`
            }
            className={`flex items-center gap-1 rounded -mx-2 transition ${on ? 'bg-bolt/10' : ''}`}
          >
            <button
              type="button"
              onClick={() => onSeek(row.startTime)}
              title={`Jump to ${fmt(row.startTime)}`}
              className={`flex-1 min-w-0 flex gap-3 items-center text-left rounded transition py-1.5 px-2 ${
                on ? 'text-bolt' : 'text-bone/80 hover:bg-bone/5'
              }`}
            >
              {/* Both row kinds go through <RowThumb> — it owns the
                  two-URL-then-hide chain and the onError that terminates on a
                  marker rather than a string compare. */}
              <RowThumb
                src={row.kind === 'track' ? row.split.image : row.chapter.img}
                fallback={fallbackImg}
                className="w-9 h-9 rounded object-cover flex-shrink-0 border border-bone/15"
              />
              <span className={`tabular-nums w-12 flex-shrink-0 ${on ? 'text-bolt' : 'text-muted'}`}>
                {fmt(row.startTime)}
              </span>
              <RowTitle row={row} chapters={chapters} index={i} />
            </button>
            {/* A chapter's external link, outside the button — see the note
                above on nested buttons. */}
            {row.kind === 'chapter' && row.chapter.url && (
              <a
                href={row.chapter.url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open chapter link"
                aria-label="Open chapter link"
                className="flex-shrink-0 px-2 py-1.5 text-muted hover:text-bolt transition"
              >
                ↗
              </a>
            )}
            {/* A link to this exact moment. Same sibling-of-the-seek-button
                rule as the anchor above, and the same padding so the two read
                as one size. Icon-only (`word=""`) because the row is the
                tightest horizontal space in the app; `title` doubles as the
                accessible name, so nothing is lost by dropping the word. */}
            {shareUrlFor && (
              <CopyLinkButton
                url={shareUrlFor(row.startTime)}
                title={`Copy link to this ${row.kind === 'chapter' ? 'chapter' : 'track'} at ${fmt(row.startTime)}`}
                word=""
                className="flex-shrink-0 px-2 py-1.5 text-muted hover:text-bolt transition text-[10px] uppercase tracking-wider"
              />
            )}
            {/* Only a track row can offer this, and <FavTrackHeart> still
                declines when the window carries no usable identifiers. */}
            {row.kind === 'track' && (
              <div className="flex-shrink-0 pr-1">
                <FavTrackHeart split={row.split} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A row's title, and the one place the three sources are ranked.
 *
 * For a track: the resolved window title, then the title of the chapter that
 * window absorbed, then the placeholder. **The middle link is why an absorbed
 * chapter is not simply discarded.** Podcast Index has not crawled every album
 * feed, so a window routinely resolves to nothing and renders as *"Track not yet
 * indexed"* — while the chapter the merge just dropped, sitting a fraction of a
 * second away, names the song outright (window `5046` on Homegrown Hits 146
 * against the `5045.605` chapter titled *"Shanti"*). Throwing that away would
 * make the merged list strictly worse than the chapters list it replaces.
 *
 * It is decoration and cannot reach a favorite: the heart is built from
 * `remoteItem`, which no part of this touches. `mergeEpisodeContents` only sets
 * `absorbedTitle` when the pairing was unambiguous.
 */
function RowTitle({
  row,
  chapters,
  index,
}: {
  row: EpisodeContentRow;
  chapters: ChapterEntry[] | null;
  index: number;
}) {
  if (row.kind === 'track') {
    const title = row.split.title ?? row.absorbedTitle;
    return (
      <span className={`break-words min-w-0 ${title ? '' : 'text-muted italic'}`}>
        {title ?? 'Track not yet indexed'}
      </span>
    );
  }
  // An untitled chapter is numbered by its position in the FEED's chapter list,
  // not by its position in the merged one — the merged index counts tracks too,
  // so it would number the chapters wrong the moment a show has both.
  const nth = chapters ? chapters.indexOf(row.chapter) : -1;
  return (
    <span className="break-words min-w-0">
      {row.chapter.title ?? `Chapter ${(nth >= 0 ? nth : index) + 1}`}
    </span>
  );
}
