'use client';
import { useCallback } from 'react';
import type { Episode, Podcast } from '@/lib/types';
import { fmtBytes } from '@/lib/format';
import { downloadManager } from '@/lib/downloads/download-manager';
import { useDownloadsVersion } from '@/lib/downloads/use-downloads';

/**
 * The download control. One button, five states, on every surface that lists an
 * episode.
 *
 * IT IS DELIBERATELY NOT MERGED INTO THE HEART, and that is a rule rather than a
 * layout choice. A tri-state heart — off / favorited / favorited-and-downloaded —
 * traps the favorite: there is no one-tap unfavorite left, and the control stops
 * working at all offline, when the favorites list cannot be published. They are
 * two independent facts about one episode and they get two controls.
 *
 * SIZES MATCH `<FavHeart>` because they share a cluster: 'sm' is the slim list-row
 * chip whose word collapses below sm:, 'md' matches `.btn-ghost`, 'tile' is the
 * `.tile` grid shape the action rows are built from. 'header' has no heart beside
 * it: it is the fullscreen player's top bar, `.btn-ghost`'s height at every width
 * so the bar is no taller than the ⚡ chip next to it, and the glyph alone below
 * sm: like 'sm'.
 *
 * THE WORD DOES NOT CHANGE WITH STATE. Same layout rule as the heart, and the
 * same reason: this control sits in right-aligned clusters, so a word that grows
 * from DOWNLOAD to DOWNLOADING would shove BOOST and the heart sideways every
 * time somebody pressed it. State is carried by the glyph, the colour and the
 * progress fill — none of which changes the box — and the whole meaning is in
 * `aria-label`, which a screen reader announces on every change.
 *
 * → docs/downloads.md
 */

type Size = 'sm' | 'md' | 'tile' | 'header';

export function DownloadButton({
  episode,
  podcast,
  size = 'sm',
}: {
  episode: Episode;
  podcast?: Podcast | null;
  size?: Size;
}) {
  // The version is a re-render trigger; everything below is read fresh off the
  // manager, which is the source of truth for both memory and disk.
  useDownloadsVersion();

  // `storedKeyFor`, never `keyFor`: this key is what CANCEL and REMOVE act on,
  // and it has to name the same record `getEpisodeState` just read. An episode
  // enriched in place with a new enclosure URL derives a different key from the
  // one its download is filed under, so the two would disagree and ✓ would
  // remove nothing.
  const state = downloadManager.getEpisodeState(episode);
  const key = downloadManager.storedKeyFor(episode);

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      // Rows that embed this are themselves clickable — they play the episode —
      // so the press must not bubble into one.
      e.stopPropagation();
      e.preventDefault();
      if (!key) return;
      switch (state.status) {
        case 'queued':
        case 'downloading':
          void downloadManager.cancel(key);
          return;
        case 'downloaded':
          void downloadManager.remove(key);
          return;
        default:
          void downloadManager.download(episode, podcast);
      }
    },
    [key, state.status, episode, podcast],
  );

  // No URL, an HLS manifest, or a live item. `<FavEpisodeHeart>` is under the
  // same rule for a different reason: a control that cannot do its job is worse
  // than an absent one, because pressing it teaches the listener nothing.
  if (!downloadManager.canDownload(episode)) return null;

  // `sizeText`, not `size` — the prop is called `size` and shadowing it here
  // silently turned every `size === 'sm'` test below into a string comparison.
  const stored = key ? downloadManager.recordSize(key) : null;
  const sizeText = fmtBytes(stored ?? episode.enclosureLength);
  const { glyph, label, tone } = present(state.status, state.fraction, episode.title, sizeText);
  const pct = state.fraction === null ? null : Math.round(state.fraction * 100);

  /**
   * ONE FIXED-WIDTH SLOT holding the size before the press and the percentage
   * during it. Both are about six characters, so reserving the width once means
   * the control never changes size — which is the layout rule <FavHeart>
   * documents, and this is the version of it that still tells the listener how
   * much data they are about to spend. Measured 2026-09-09: Homegrown Hits
   * episodes run 160-190 MB, so "before the press" is not a nicety.
   *
   * Empty when the feed states no size, because both sources routinely say `0`
   * and "0 MB" beside a 160 MB file is worse than silence.
   */
  const meta =
    state.status === 'downloading' && pct !== null ? `${pct}%`
      : state.status === 'queued' ? '···'
        : sizeText ?? '';

  return (
    <span className={`inline-flex flex-col items-stretch gap-1 ${size === 'header' ? 'relative' : ''}`}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title={label}
        // `relative overflow-hidden` is what lets the progress fill live inside
        // the button without being able to change its size.
        className={`relative overflow-hidden ${classesFor(size, tone)}`}
      >
        {/* PROGRESS IS A BACKGROUND, NOT A NUMBER IN THE LABEL. A percentage in
            the text would resize this control ~20 times per download, and it is
            the last item in a right-aligned row. The width is the only thing
            that animates, and width on an absolutely-positioned child moves
            nothing around it. `aria-hidden` because the label already says it. */}
        {pct !== null && (state.status === 'downloading' || state.status === 'queued') && (
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 bg-bone/20 transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        )}
        {/* FIXED-WIDTH GLYPH BOX, for the reason spelled out on <FavHeart>: the
            glyphs are not the same width and none of them is in JetBrains Mono,
            so each falls back per glyph. Without the box, every state change
            resizes the chip. */}
        {/* 'header' sets the glyph on `leading-5`, the line box of `.btn-ghost`'s
            `text-sm`: with the word hidden below sm: the glyph is the only
            line, and a `leading-none` one would leave this chip 2px shorter
            than the ⚡ chip beside it. */}
        <span
          className={`relative inline-block w-[0.9em] text-center ${
            size === 'sm' ? 'text-base leading-none'
              : size === 'header' ? 'text-base leading-5'
                : 'text-lg leading-none'
          } ${state.status === 'downloading' || state.status === 'queued' ? 'animate-bolt' : ''}`}
        >
          {glyph}
        </span>
        {/* 'sm' collapses to the glyph below sm:. Its one consumer, the
            episode row, shows it from lg: only now — below that DOWNLOAD is a
            'tile' in the row's `⋯` menu — but a list row on a phone has no
            width for the word, so the collapse stays for the next one. The
            aria-label above carries the full meaning, so nothing is lost. */}
        <span className={`relative ${size === 'sm' || size === 'header' ? 'hidden sm:inline' : undefined}`}>
          DOWNLOAD
        </span>
        {/* `.tile` is 52px tall and already stacks a glyph over a word, so the
            third line goes only on the inline sizes; at 'tile' the size stays in
            the accessible name. `tabular-nums` and a reserved width are what
            make "162 MB" and "47%" occupy the same box.
            5.5ch DOES NOT HOLD SIX tracked characters, so on 'sm' and 'md' a
            size wraps to two lines — and on the desktop list chip that second
            line IS its height (26px, no `py`), which is why it stays. 'header'
            sits beside a one-line ⚡ chip, so it gets the width six need. */}
        {size !== 'tile' && meta && (
          <span
            aria-hidden
            className={`relative text-right tabular-nums opacity-70 ${
              size === 'header' ? 'w-[6.5ch] whitespace-nowrap' : 'w-[5.5ch]'
            } ${size === 'sm' || size === 'header' ? 'hidden sm:inline-block' : 'inline-block'}`}
          >
            {meta}
          </span>
        )}
      </button>
      {/* A GUARD THAT WITHHOLDS MUST SAY SO. `title` is not an answer on a
          phone, and a red glyph alone says something went wrong without saying
          what — "no space" and "this host does not allow downloads" need
          different things from the listener. The message wraps under the chip
          rather than inside it, so it cannot resize the control.
          In the 'header' it FLOATS under the chip instead: in the flow it would
          make the player's top bar taller, and that bar's height is part of the
          reserve that keeps the tile row on a phone's screen. Right-aligned,
          because the chip sits near the right edge of the bar. */}
      {state.status === 'error' && state.error && (
        <span
          role="alert"
          className={`max-w-[22ch] text-[11px] leading-tight text-red-400 ${
            size === 'header'
              ? 'absolute right-0 top-full z-10 mt-1 w-max border border-red-400/60 bg-ink px-2 py-1'
              : ''
          }`}
        >
          {state.error}
        </span>
      )}
    </span>
  );
}

/**
 * The download state as a few words for a line of text, or nothing when there
 * is no download. For a surface that shows the state without the control — the
 * episode row on a phone, where DOWNLOAD is inside its `⋯` menu and a download
 * running for minutes would otherwise show progress nowhere. Reads the manager
 * exactly as the button does, and says nothing about an idle episode: a mark on
 * every row would be noise.
 */
export function DownloadMark({ episode, className = '' }: { episode: Episode; className?: string }) {
  useDownloadsVersion();
  if (!downloadManager.canDownload(episode)) return null;
  const state = downloadManager.getEpisodeState(episode);
  const pct = state.fraction === null ? null : Math.round(state.fraction * 100);
  const text =
    state.status === 'downloaded' ? '✓ downloaded'
      : state.status === 'downloading' ? (pct === null ? '↓ downloading' : `↓ ${pct}%`)
        : state.status === 'queued' ? '↓ waiting'
          : state.status === 'error' ? '! download failed'
            : null;
  if (!text) return null;
  return (
    <span className={`whitespace-nowrap tabular-nums ${state.status === 'error' ? 'text-red-400' : 'text-bone/80'} ${className}`}>
      · {text}
    </span>
  );
}

type Tone = 'idle' | 'busy' | 'done' | 'error';

function present(
  status: string,
  fraction: number | null,
  title: string,
  sizeText: string | null,
): { glyph: string; label: string; tone: Tone } {
  switch (status) {
    case 'queued':
      return { glyph: '⋯', label: `Cancel the queued download of ${title}`, tone: 'busy' };
    case 'downloading': {
      const pct = fraction === null ? null : Math.round(fraction * 100);
      return {
        glyph: '↓',
        // The percentage lives HERE rather than in the visible word, so it is
        // announced without being able to resize anything.
        label: pct === null ? `Downloading ${title}. Press to cancel.` : `Downloading ${title}, ${pct}%. Press to cancel.`,
        tone: 'busy',
      };
    }
    case 'downloaded':
      return { glyph: '✓', label: `Remove the download of ${title}`, tone: 'done' };
    case 'error':
      return { glyph: '!', label: `Download of ${title} failed. Press to try again.`, tone: 'error' };
    default:
      // The size is in the accessible name at EVERY size, including 'tile'
      // where there is no room to show it — a `title` tooltip is not an answer
      // on a phone, and this is the moment somebody decides to spend 160 MB.
      return {
        glyph: '↓',
        label: sizeText
          ? `Download ${title} to play without a connection. ${sizeText}.`
          : `Download ${title} to play without a connection`,
        tone: 'idle',
      };
  }
}

function classesFor(size: Size, tone: Tone): string {
  if (size === 'tile') {
    // `.tile` already carries the idle border and text colour, so only the
    // non-idle states layer anything on — the same construction as <FavHeart>'s
    // tile branch, which is why these two sit level in an action row.
    const tile =
      tone === 'error'
        ? 'border-red-400/60 text-red-400 hover:border-red-400 hover:bg-red-400/10'
        : tone === 'done' || tone === 'busy'
          ? 'border-bone text-bone hover:border-bone hover:bg-bone/10'
          : '';
    return `tile ${tile}`;
  }

  const colour =
    tone === 'error'
      ? 'border-red-400/60 text-red-400 hover:bg-red-400/10'
      : tone === 'done' || tone === 'busy'
        ? 'border-bone text-bone hover:bg-bone/10'
        : 'border-bone/40 text-bone/70 hover:border-bone hover:text-bone';

  // Touch target comes from min-h/min-w rather than padding, so the desktop chip
  // stays slim while the mobile one clears WCAG 2.5.8's 24px floor with room to
  // spare — same construction as <FavHeart>'s 'sm'.
  return `inline-flex items-center justify-center font-mono uppercase tracking-wider border transition active:translate-y-px flex-shrink-0 ${
    size === 'md'
      ? 'gap-1.5 px-2.5 py-2 text-sm sm:gap-2 sm:px-4'
      : size === 'header'
        ? 'gap-1.5 px-3 py-2 text-sm sm:gap-2 sm:px-4'
        : 'gap-1.5 px-3 text-xs leading-none min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0'
  } ${colour}`;
}
