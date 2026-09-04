'use client';

// Search-results panel, and the single podcast row it shares with the
// favorites panel.

// One row used by both the search-results panel and the favorites panel.
// `showV4VStamp` is on for search results (where the value-block is known)
// and off for favorites (the cache only carries metadata, not value).
import type { Podcast } from '@/lib/types';
import { isPlaylistMedium } from '@/lib/util';
import { PodcastCover } from '../podcast-cover';
import { FavHeart } from '../fav-heart';

export function PodcastRow({
  podcast,
  selected,
  onSelect,
  showV4VStamp,
  meta,
  piUnasked,
}: {
  podcast: Podcast;
  selected: boolean;
  onSelect: (p: Podcast) => void;
  showV4VStamp: boolean;
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
}) {
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
      className={`flex gap-3 px-1 group transition ${
        selected ? 'bg-bolt/10' : 'hover:bg-bone/5'
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(podcast)}
        aria-current={selected || undefined}
        className="flex-1 min-w-0 flex gap-3 py-3 text-left cursor-pointer"
      >
        <PodcastCover
          image={podcast.image}
          artwork={podcast.artwork}
          title={podcast.title}
          seed={podcast.podcastGuid ?? String(podcast.id)}
          className="w-14 h-14 border border-bone/20 flex-shrink-0 text-xl"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-display text-base leading-tight truncate">{podcast.title}</span>
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
              <span className="stamp text-muted border-muted/40">♫ PLAYLIST</span>
            )}
            {showV4VStamp && podcast.value && (
              <span className="stamp text-bolt border-bolt/60">⚡ V4V</span>
            )}
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
        </div>
      </button>
      <FavHeart podcast={podcast} />
    </li>
  );
}

export function PodcastResults({
  feeds,
  selected,
  onSelect,
  empty,
  meta,
  piUnasked,
}: {
  feeds: Podcast[];
  selected: number | null;
  onSelect: (p: Podcast) => void;
  /** Per-row extra text for the secondary line — see `<PodcastRow>`'s `meta`. */
  meta?: (p: Podcast) => React.ReactNode;
  /** Podcast Index was never asked — see `<PodcastRow>`'s `piUnasked`. */
  piUnasked?: boolean;
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
    <ul className="divide-y divide-bone/10">
      {feeds.map((p) => (
        <PodcastRow
          key={p.id}
          podcast={p}
          selected={selected === p.id}
          onSelect={onSelect}
          showV4VStamp
          meta={meta?.(p)}
          piUnasked={piUnasked}
        />
      ))}
    </ul>
  );
}
