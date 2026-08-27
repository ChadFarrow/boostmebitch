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
}: {
  podcast: Podcast;
  selected: boolean;
  onSelect: (p: Podcast) => void;
  showV4VStamp: boolean;
}) {
  return (
    <li
      onClick={() => onSelect(podcast)}
      className={`flex gap-3 py-3 px-1 cursor-pointer group transition ${
        selected ? 'bg-bolt/10' : 'hover:bg-bone/5'
      }`}
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
          {podcast.isPreview && (
            <span className="stamp text-muted border-muted/40">NOT IN PI</span>
          )}
          {podcast.medium === 'publisher' && (
            <span className="stamp text-muted border-muted/40">▸ ALBUMS</span>
          )}
          {/* Through the helper, not a raw `=== 'musicL'`: the RSS parsers
              lowercase the tag and Podcast Index returns its own spelling, so a
              literal comparison stamps one of the two paths and silently not
              the other. */}
          {isPlaylistMedium(podcast) && (
            <span className="stamp text-muted border-muted/40">♫ PLAYLIST</span>
          )}
          {showV4VStamp && podcast.value && (
            <span className="stamp text-bolt border-bolt/60">⚡ V4V</span>
          )}
        </div>
        <div className="text-xs text-muted truncate">{podcast.author}</div>
      </div>
      <FavHeart podcast={podcast} />
    </li>
  );
}

export function PodcastResults({
  feeds,
  selected,
  onSelect,
}: {
  feeds: Podcast[];
  selected: number | null;
  onSelect: (p: Podcast) => void;
}) {
  if (!feeds.length) {
    return <p className="text-muted text-sm py-8 px-1">no results yet — try another phrase</p>;
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
        />
      ))}
    </ul>
  );
}
