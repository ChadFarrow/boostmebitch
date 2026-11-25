'use client';
import { useMemo } from 'react';
import { fmt } from '@/lib/format';
import { mergeEpisodeContents, splitAtPosition, type EpisodeContentRow } from '@/lib/util';
import type { ChapterEntry, ValueTimeSplit } from '@/lib/types';
import { ChapterUrlLink, RowThumb } from './chapter-ui';
import { FavTrackHeart } from './fav-heart';
import { SaveToPlaylistButton, targetFromSplit } from './community/save-to-playlist';
import { COMMUNITY_PLAYLISTS_ON } from '@/lib/curated-playlists';
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
 * a chapter's link mark sits outside it: a button or a link inside a button is
 * invalid HTML and browsers reparent it, which drops the row's click target on
 * the floor. `<FavTrackHeart>` stops propagation of its own accord anyway.
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
        const title = rowTitle(row, chapters, i);
        return (
          <li
            key={
              row.kind === 'track'
                ? `t-${row.startTime}-${row.split.remoteItem?.itemGuid ?? i}`
                : `c-${row.startTime}-${row.chapter.title ?? i}`
            }
            // `relative` is the containing block the seek button's `after:`
            // overlay stretches over — see the note on the button.
            className={`relative flex items-center gap-1 rounded -mx-2 transition ${
              on ? 'bg-bolt/10 text-bolt' : 'text-bone/80 hover:bg-bone/5'
            }`}
          >
            <div className="flex-1 min-w-0 flex gap-3 items-center py-1.5 px-2">
              {/* **The seek button covers the WHOLE row through its `after:`
                  overlay, and holds only the thumbnail and the time.** The
                  chapter's link mark has to follow the title's last word, so
                  the title and the mark share one line of text — and an anchor
                  may not sit inside a button (browsers reparent it, which drops
                  the row's click target on the floor). So the title is a
                  sibling, and the overlay (positioned, painted above the
                  unpositioned title) still makes a tap anywhere on the row
                  seek. Everything else that takes a tap here is `relative`, so
                  it paints above the overlay: the mark, share, the heart.
                  The visible title is `aria-hidden` and the button carries an
                  `sr-only` copy, so the button's accessible name is still
                  "time title", as it was when the title was inside it. The
                  focus ring is drawn on the overlay, around the whole row. */}
              <button
                type="button"
                onClick={() => onSeek(row.startTime)}
                title={`Jump to ${fmt(row.startTime)}`}
                className="flex-shrink-0 flex gap-3 items-center text-left focus-visible:outline-none after:absolute after:inset-0 after:rounded after:content-[''] focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-bolt"
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
                <span className="sr-only">{title.text}</span>
              </button>
              <span className="flex-1 min-w-0 break-words">
                <span aria-hidden className={title.placeholder ? 'text-muted italic' : ''}>
                  {title.text}
                </span>
                {/* A chapter's external link, right after its title. The
                    no-break space keeps the mark on the line of the title's
                    last word when the title wraps. */}
                {row.kind === 'chapter' && row.chapter.url && (
                  <>
                    {'\u00a0'}
                    <ChapterUrlLink
                      href={row.chapter.url}
                      label={`Open chapter link: ${title.text}`}
                      className="relative -ml-1"
                    />
                  </>
                )}
              </span>
            </div>
            {/* A link to this exact moment. A sibling of the seek button, by
                the same nested-button rule as the heart below, and `relative`
                so it paints above the button's row overlay. Icon-only
                (`word=""`) because the row is the tightest horizontal space in
                the app; `title` doubles as the accessible name, so nothing is
                lost by dropping the word. */}
            {shareUrlFor && (
              <CopyLinkButton
                url={shareUrlFor(row.startTime)}
                title={`Copy link to this ${row.kind === 'chapter' ? 'chapter' : 'track'} at ${fmt(row.startTime)}`}
                word=""
                className="relative flex-shrink-0 px-2 py-1.5 text-muted hover:text-bolt transition text-[10px] uppercase tracking-wider"
              />
            )}
            {/* Only a track row can offer this, and <FavTrackHeart> still
                declines when the window carries no usable identifiers. */}
            {row.kind === 'track' && (
              <div className={`relative flex-shrink-0 pr-1${COMMUNITY_PLAYLISTS_ON ? ' flex items-center gap-1' : ''}`}>
                {/* "+ PLAYLIST" to the heart's LEFT: the heart stays the last
                    item of the row (docs/ui.md). Nothing while the maker is off. */}
                <SaveToPlaylistButton target={targetFromSplit(row.split)} />
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
function rowTitle(
  row: EpisodeContentRow,
  chapters: ChapterEntry[] | null,
  index: number,
): { text: string; placeholder: boolean } {
  if (row.kind === 'track') {
    const title = row.split.title ?? row.absorbedTitle;
    return title ? { text: title, placeholder: false } : { text: 'Track not yet indexed', placeholder: true };
  }
  // An untitled chapter is numbered by its position in the FEED's chapter list,
  // not by its position in the merged one — the merged index counts tracks too,
  // so it would number the chapters wrong the moment a show has both.
  const nth = chapters ? chapters.indexOf(row.chapter) : -1;
  return { text: row.chapter.title ?? `Chapter ${(nth >= 0 ? nth : index) + 1}`, placeholder: false };
}
