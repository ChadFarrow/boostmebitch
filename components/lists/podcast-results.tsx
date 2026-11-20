'use client';

// Search-results panel, and the single podcast row it shares with the
// favorites panel.

// One row used by both the search-results panel and the favorites panel.
// `showV4VStamp` is on for search results (where the value-block is known)
// and off for favorites (the cache only carries metadata, not value).
import type { Podcast } from '@/lib/types';
import { carriesV4V, isPlaylistMedium, playlistCoverFallback } from '@/lib/util';
import { PodcastCover } from '../podcast-cover';
import { FavHeart } from '../fav-heart';
import { PlaylistIcon } from '../icons';

/**
 * A cover that is its own control — see `<PodcastRow>`'s `coverPlay`. Built by
 * `useAlbumCoverPlay` (`components/lists/use-album-cover-play.ts`).
 *
 * `state` is what the overlay on the cover draws and what a press does next:
 * - `idle` ▶ — the album is not playing; a press starts it at its first track.
 *   The overlay shows only under a mouse's hover or a keyboard's focus.
 * - `loading` … — the press is waiting for the album's feed.
 * - `playing` ❚❚ — a track of this album plays; a press pauses it.
 * - `paused` ▶ — a track of this album is paused; a press resumes it.
 * - `failed` ! — the last press could not load the album; a press tries again.
 */
export interface CoverPlay {
  state: 'idle' | 'loading' | 'playing' | 'paused' | 'failed';
  onPress: () => void;
}

const COVER_PLAY_GLYPH: Record<CoverPlay['state'], string> = {
  idle: '▶', loading: '…', playing: '❚❚', paused: '▶', failed: '!',
};
// `title` is the short word a pointer user reads; the accessible name carries
// the album too, because a list of covers is a list of identical buttons to a
// screen reader otherwise.
const COVER_PLAY_TITLE: Record<CoverPlay['state'], string> = {
  idle: 'Play album', loading: 'Loading the album…', playing: 'Pause', paused: 'Resume',
  failed: 'Could not load the album. Press to try again.',
};
const coverPlayLabel = (state: CoverPlay['state'], title: string) => ({
  idle: `Play ${title}`, loading: `Loading ${title}`, playing: `Pause ${title}`, paused: `Resume ${title}`,
  failed: `Could not load ${title}. Press to try again.`,
})[state];

export function PodcastRow({
  podcast,
  selected,
  onSelect,
  showV4VStamp,
  meta,
  detail,
  stamp,
  coverBadge,
  coverPlay,
  piUnasked,
  action,
  footer,
}: {
  podcast: Podcast;
  selected: boolean;
  onSelect: (p: Podcast) => void;
  showV4VStamp: boolean;
  /**
   * A short third line that must NEVER be cut — `/demu` puts the date and age
   * of the newest track here (`Nov 14 · 1 day`). Not `meta`: that rides at the
   * end of the author line, which truncates, and at 390px it hid the age on
   * every row (measured, final review 2026-11-15). Optional; absent changes
   * nothing.
   */
  detail?: React.ReactNode;
  /**
   * One more stamp in the title row, after the built-in ones — `/demu` marks an
   * album shown without a value block (`NO VALUE BLOCK`). In the row that wraps,
   * so it is never cut at 390px. Optional; absent changes nothing.
   */
  stamp?: React.ReactNode;
  /**
   * A small badge over the cover's top-left corner, positioned by the caller
   * (`absolute`) inside a `relative` box the size of the cover — `/demu` shows
   * which app made the feed. It is inside the row's button, so give it an
   * accessible name. Optional; absent changes nothing.
   */
  coverBadge?: React.ReactNode;
  /**
   * Make the COVER its own control: a press plays the album, and the rest of
   * the row still opens it — `/demu` (Chad, 2026-11-16: "if I click the
   * artwork could it just play it?"). The cover then leaves the row's button
   * and becomes a SIBLING button, because a button may not contain another
   * button. Its glyph is a dark overlay ON the art — the episode row's shape —
   * never a badge: a round ▶ badge on every cover was "too distracting" (Chad,
   * iPhone, beta, 2026-11-17: "can it just maybe be like a transparent overlay
   * kind of on the art … where you just kind of tap the art"). The album that
   * holds the player keeps the overlay and a bolt border; an idle cover shows
   * it only to a mouse's hover or a keyboard's focus. Optional; absent changes
   * nothing.
   */
  coverPlay?: CoverPlay;
  /**
   * Extra text for the secondary line, beside the author.
   *
   * Optional, so every existing caller is untouched. `/playlists` uses it for a
   * track count that arrives AFTER the row paints — which is why the caller
   * decides what to render rather than passing a number: "we have not been told
   * yet" and "we asked and got no answer" are the same thing on screen, and
   * both must render nothing rather than a zero.
   */
  meta?: React.ReactNode;
  /**
   * True when Podcast Index was never asked about this row, which SUPPRESSES
   * the `NOT IN PI` stamp.
   *
   * `isPreview` means "this record was built from RSS", and the stamp reads it
   * as "Podcast Index does not hold this feed". Those are the same thing only
   * when we actually asked. Under a PI rate limit `/api/publisher` answers from
   * the children's own RSS without asking at all, and the stamp then printed
   * `NOT IN PI` on ten playlists Podcast Index does hold — It's A Mood is feed
   * 7443544. Reported 2026-08-29: "why does it say not in PI when some are?".
   *
   * Suppressing rather than rewording is deliberate. There is no third stamp
   * worth spending a row on for a state that lasts one load and self-corrects,
   * and the honest claim is simply that we do not know.
   */
  piUnasked?: boolean;
  /**
   * An extra control for this row (`/playlists`' EDIT link). Rendered as a
   * SIBLING of the opening button, beside the heart, never inside it: a button
   * may not contain another interactive element.
   */
  action?: React.ReactNode;
  /**
   * A line under the row, INSIDE its `<li>` — `/favorites` puts the moved-album
   * offer here (`<MovedOffer>`). Inside rather than a sibling `<li>` because the
   * list is a two-column grid from `lg:`, where a sibling would take a cell of
   * its own and break every pair after it. Optional; absent changes nothing.
   */
  footer?: React.ReactNode;
}) {
  // The album holds the player, playing or paused. That follows WHICH album
  // is current; the glyph follows the transport — the episode row's rule, so a
  // paused album still shows where its ▶ is.
  const holds = coverPlay?.state === 'playing' || coverPlay?.state === 'paused';
  const cover = (
    <div className="relative flex-shrink-0">
      <PodcastCover
        image={podcast.image}
        artwork={podcast.artwork}
        title={podcast.title}
        seed={podcast.podcastGuid ?? String(podcast.id)}
        fallbackSrc={playlistCoverFallback(podcast)}
        className={`w-14 h-14 border flex-shrink-0 text-xl ${
          holds ? 'border-bolt' : coverPlay ? 'border-bone/20 [@media(hover:hover)]:group-hover/cover:border-bolt' : 'border-bone/20'
        }`}
      />
      {coverPlay ? (
        // The overlay sits INSIDE the cover's border (`inset-px`), so the bolt
        // border of the current album is not dimmed by it. An idle cover's
        // overlay reveals on hover only where hover is real — `(hover: hover)`:
        // iOS keeps `:hover` on the last element tapped, and a held reveal on
        // an idle album would read as "this one is current". A tap still
        // answers through `active:`, and a keyboard through `focus-visible:`.
        // Before the app badge in the DOM, so that badge stays on top.
        <span
          aria-hidden
          data-cover-play-glyph
          className={`absolute inset-px grid place-items-center bg-ink/55 text-base leading-none transition-opacity pointer-events-none ${
            coverPlay.state === 'idle'
              ? 'opacity-0 text-bone [@media(hover:hover)]:group-hover/cover:opacity-100 [@media(hover:hover)]:group-hover/cover:text-bolt group-focus-visible/cover:opacity-100 group-active/cover:opacity-100'
              : coverPlay.state === 'failed'
                ? 'opacity-100 text-nostr'
                : 'opacity-100 text-bolt'
          }`}
        >
          <span className={coverPlay.state === 'loading' ? 'animate-pulse' : undefined}>
            {COVER_PLAY_GLYPH[coverPlay.state]}
          </span>
        </span>
      ) : null}
      {coverBadge}
    </div>
  );
  return (
    // The row's opening control is a real <button>, with <FavHeart> as its
    // SIBLING — the same shape <EpisodeContents> uses for its seek row, and for
    // the same reason: a button may not contain another button, and the heart
    // is one. This was an `<li onClick>` with no role, no tabIndex and no key
    // handler, which made picking a search result POINTER-ONLY. A keyboard or
    // switch user could reach the heart (favouriting a show they cannot open)
    // and nothing else, on the one control this whole panel exists for.
    //
    // The hover tint stays on the <li> so the full width still reacts, while
    // the padding moves inside the button so the focus ring and the hit area
    // describe the same box.
    <li
      className={`flex gap-3 px-1 group transition ${footer ? 'flex-wrap' : ''} ${
        selected ? 'bg-bolt/10' : 'hover:bg-bone/5'
      }`}
    >
      {coverPlay ? (
        // Full row height with the row button's `py-3`, so the cover sits where
        // it sat inside that button and the whole left column is the target.
        <button
          type="button"
          data-cover-play={coverPlay.state}
          onClick={coverPlay.onPress}
          aria-label={coverPlayLabel(coverPlay.state, podcast.title)}
          aria-busy={coverPlay.state === 'loading' || undefined}
          title={COVER_PLAY_TITLE[coverPlay.state]}
          className="group/cover flex-shrink-0 py-3 cursor-pointer"
        >
          {cover}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => onSelect(podcast)}
        aria-current={selected || undefined}
        className="flex-1 min-w-0 flex gap-3 py-3 text-left cursor-pointer"
      >
        {coverPlay ? null : cover}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-display text-base leading-tight line-clamp-2 break-words min-w-0">{podcast.title}</span>
            {podcast.isPreview && !piUnasked && (
              <span className="stamp text-muted border-muted/40">NOT IN PI</span>
            )}
            {podcast.medium === 'publisher' && (
              <span className="stamp text-muted border-muted/40">▸ ALBUMS</span>
            )}
            {/* Through the helper, not a raw `=== 'musicL'`: the RSS parsers
                lowercase the tag and Podcast Index returns its own spelling, so
                a literal comparison stamps one of the two paths and silently
                not the other. */}
            {isPlaylistMedium(podcast) && (
              <span data-stamp="playlist" className="stamp text-muted border-muted/40"><PlaylistIcon /> PLAYLIST</span>
            )}
            {showV4VStamp && carriesV4V(podcast) && (
              <span className="stamp text-bolt border-bolt/60">⚡ V4V</span>
            )}
            {stamp}
          </div>
          <div className="text-xs text-muted truncate">
            {podcast.author}
            {meta ? (
              <>
                {podcast.author ? ' · ' : ''}
                {meta}
              </>
            ) : null}
          </div>
          {detail ? <div className="text-xs text-muted whitespace-nowrap mt-0.5">{detail}</div> : null}
        </div>
      </button>
      {/* `self-center`, and it is not cosmetic: a bare flex child inherits
          `align-items: stretch`, so the heart's BORDER grew to the full height
          of the row — a 76px magenta box against the 44px touch target the
          `sm` chip's `min-h`/`min-w` describe. Every other row that renders
          this heart wraps it exactly like this (see <FavoriteItemRows> and
          <Podroll>); this one did not, and it is the row the favorites page is
          almost entirely made of. */}
      <div className={`flex-shrink-0 self-center${action ? ' flex items-center gap-2' : ''}`}>
        {action}
        <FavHeart podcast={podcast} />
      </div>
      {footer}
    </li>
  );
}

export function PodcastResults({
  feeds,
  selected,
  onSelect,
  empty,
  meta,
  detail,
  stamp,
  coverBadge,
  coverPlay,
  piUnasked,
  action,
}: {
  feeds: Podcast[];
  selected: number | null;
  onSelect: (p: Podcast) => void;
  /** Per-row extra text for the secondary line — see `<PodcastRow>`'s `meta`. */
  meta?: (p: Podcast) => React.ReactNode;
  /** Per-row line that is never cut — see `<PodcastRow>`'s `detail`. */
  detail?: (p: Podcast) => React.ReactNode;
  /** Per-row extra stamp in the title row — see `<PodcastRow>`'s `stamp`. */
  stamp?: (p: Podcast) => React.ReactNode;
  /** Per-row badge over the cover — see `<PodcastRow>`'s `coverBadge`. */
  coverBadge?: (p: Podcast) => React.ReactNode;
  /** Per-row cover control, or null for a row whose cover stays inside the row — see `<PodcastRow>`'s `coverPlay`. */
  coverPlay?: (p: Podcast) => CoverPlay | null;
  /** Podcast Index was never asked — see `<PodcastRow>`'s `piUnasked`. */
  piUnasked?: boolean | ((p: Podcast) => boolean);
  /** Per-row extra control — see `<PodcastRow>`'s `action`. */
  action?: (p: Podcast) => React.ReactNode;
  /**
   * What to say when there are no rows.
   *
   * A prop rather than a string here because the sentence depends on something
   * this component cannot see: whether a TYPE FILTER is narrowing the list. "no
   * results yet" is a claim about Podcast Index, and under a chip it is a false
   * one — the index may hold plenty, none of it music. Same rule the favorites
   * page follows for its own filter: a filter that matches nothing is not an
   * empty library, and saying so in the same words is the lie.
   *
   * Defaults to the original sentence, which is still right for an unfiltered
   * search and for the publisher view that also renders this list.
   */
  empty?: React.ReactNode;
}) {
  if (!feeds.length) {
    return (
      <div className="py-8 px-1">
        {empty ?? <p className="text-muted text-sm">no results yet — try another phrase</p>}
      </div>
    );
  }
  return (
    // Two columns from lg:. A row is a cover, a title and a heart, and at
    // 1440px one per line left ~900px of empty space between the two. The
    // dividers become each row's own bottom border there, because `divide-y`
    // draws a top border on every item after the first — in two columns that
    // put a rule above the top-right row and none under the last pair.
    // `divide-y` is `max-lg:`, never undone with `lg:divide-y-0`: that rule's
    // `> * ~ *` selector outranks `[&>li]:border-b` and zeroed the border on
    // every row but the first.
    <ul className="max-lg:divide-y max-lg:divide-bone/10 lg:grid lg:grid-cols-2 lg:gap-x-6 lg:[&>li]:border-b lg:[&>li]:border-bone/10">
      {feeds.map((p) => (
        <PodcastRow
          key={p.id}
          podcast={p}
          selected={selected === p.id}
          onSelect={onSelect}
          showV4VStamp
          meta={meta?.(p)}
          detail={detail?.(p)}
          stamp={stamp?.(p)}
          coverBadge={coverBadge?.(p)}
          coverPlay={coverPlay?.(p) ?? undefined}
          piUnasked={typeof piUnasked === 'function' ? piUnasked(p) : piUnasked}
          action={action?.(p)}
        />
      ))}
    </ul>
  );
}
