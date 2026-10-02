'use client';

import { useState } from 'react';
import type { Episode, Podcast } from '@/lib/types';
import { useApp } from '@/lib/store';
import { getErrorMessage } from '@/lib/util';
import { likeEpisode, unlikeEpisode, useEpisodeLikes } from '@/lib/use-episode-likes';
import { canFavoriteEpisode } from './fav-heart';
import { ThumbsUpIcon } from './icons';

const compact = new Intl.NumberFormat('en', { notation: 'compact' });

/**
 * 👍 LIKE — a NIP-25 kind:17 on the episode, in the shape Fountain publishes,
 * with the number of people who liked it.
 *
 * **Not a heart, on purpose.** ♡ is FAVORITE, a private-or-public list entry
 * this app syncs (kind:10333); a like is a public reaction other apps count.
 * The two sit in the same row, so they must not look alike.
 *
 * **It never prints a zero.** A count is a CLAIM, and a read that has not
 * answered — or answered from fewer relays than it asked — says nothing about
 * zero. So no likes and no answer both read plain LIKE; a number appears only
 * when somebody has. A read that filled the relay cap prints `500+`.
 *
 * The gate is `<FavEpisodeHeart>`'s: both guids or no tile. The feed guid is
 * the item's PARENT (`episode.podcastGuid` first), for the reason that
 * component gives — a playlist is not the show a track belongs to.
 *
 * `className` is `.tile`: this is only ever a peer in a tile row. → docs/nostr.md
 */
export function EpisodeLikeButton({ episode, podcast }: { episode: Episode; podcast?: Podcast | null }) {
  const itemGuid = episode.guid;
  const feedGuid = episode.podcastGuid || podcast?.podcastGuid;
  const likeable = canFavoriteEpisode(episode, podcast);
  const identity = useApp((s) => s.identity);
  const setSignInOpen = useApp((s) => s.setSignInOpen);
  const { tally } = useEpisodeLikes(likeable ? itemGuid : undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!likeable || !itemGuid || !feedGuid) return null;

  const liked = !!tally && tally.viewerLikeIds.length > 0;
  const count = tally?.count ?? 0;
  const countLabel = count > 0 ? `${compact.format(count)}${tally?.capped ? '+' : ''}` : null;

  async function onPress(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (busy) return;
    if (!identity) {
      setSignInOpen(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (liked) await unlikeEpisode({ itemGuid: itemGuid!, likeIds: tally!.viewerLikeIds, identity });
      else await likeEpisode({ itemGuid: itemGuid!, feedGuid: feedGuid!, identity });
    } catch (err) {
      // A guard that silently withholds must say so: the tile keeps its state,
      // and says why on the tile itself rather than in the console.
      setError(getErrorMessage(err, liked ? 'unlike failed' : 'like failed'));
    } finally {
      setBusy(false);
    }
  }

  const people = !countLabel ? '' : count === 1 ? ' 1 person likes this.' : ` ${countLabel} people like this.`;
  const title = error
    ? `Failed: ${error}`
    : !identity
      ? `Like on Nostr (sign in first).${people}`
      : liked
        ? `Unlike (publishes a Nostr deletion).${people}`
        : `Like on Nostr.${people}`;

  return (
    <button
      type="button"
      onClick={onPress}
      disabled={busy}
      aria-pressed={liked}
      aria-busy={busy}
      aria-label={`${liked ? 'Unlike' : 'Like'} episode${countLabel ? `, ${countLabel} ${count === 1 ? 'like' : 'likes'}` : ''}`}
      title={title}
      className={`tile disabled:opacity-60 ${
        error
          ? 'border-red-400/60 text-red-400'
          // Bone until liked, then `bolt` yellow with the thumb filled — the
          // site's own accent, rather than the heart's Nostr magenta.
          : liked
            ? 'border-bolt text-bolt hover:border-bolt hover:bg-bolt/10'
            : 'hover:border-bolt/70 hover:text-bolt'
      }`}
    >
      <span className="flex items-center gap-1 leading-none">
        <ThumbsUpIcon filled={liked} />
        {countLabel && <span className="text-[11px] tabular-nums">{countLabel}</span>}
      </span>
      {error ? 'RETRY' : 'LIKE'}
    </button>
  );
}
