'use client';

import { useRef, useState } from 'react';
import type { Episode, Podcast } from '@/lib/types';
import { useApp } from '@/lib/store';
import { likeEpisode, likeFailureText, unlikeEpisode, useEpisodeLikes } from '@/lib/use-episode-likes';
import { canFavoriteEpisode } from './fav-heart';
import { ThumbsUpIcon } from './icons';

const compact = new Intl.NumberFormat('en', { notation: 'compact' });

/** How long a signer may take before the tile says it is waiting for one. A
 *  working extension answers in well under a second; a remote signer that
 *  needs a tap on another device can take a few. */
const SIGNER_WAIT_MS = 5_000;

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
 * when somebody has. A read that filled the relay cap prints `500+`, and one
 * that missed a relay prints `N+`: a lower bound, never an exact figure.
 *
 * **Signed in, it is disabled until the first read lands**, because until then
 * a press cannot know whether it is a like or an unlike.
 *
 * **A signer that does not answer is SAID, and can be walked away from.** A
 * NIP-07 extension that goes away does not reject, it hangs, and a dimmed tile
 * reads as "nothing happened". After `SIGNER_WAIT_MS` the tile reads WAITING
 * and is pressable again; that press stops the wait, and a signature arriving
 * afterwards is dropped — never published (`signAndPublish`'s `signal`).
 *
 * **A failure is written UNDER the tile**, as `<DownloadButton>` does, because a
 * phone shows no `title`. It is a sibling of the button, `col-span-full` and
 * `order-last`, so in either tile grid it takes a row of its own at the end
 * rather than resizing a tile.
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
  const { tally, complete } = useEpisodeLikes(likeable ? itemGuid : undefined, feedGuid);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const stop = useRef<AbortController | null>(null);
  // Keyed by what the press was ABOUT. The ⋯ menu stays open across a track
  // change, and a later read can turn a failed like into a standing one; a bare
  // string would then leave RETRY over a press that now does something else —
  // an unlike, or a like of the next track.
  const [failure, setFailure] = useState<{ key: string; msg: string } | null>(null);

  if (!likeable || !itemGuid || !feedGuid) return null;

  const liked = !!tally && tally.viewerLikeIds.length > 0;
  // Until the first read lands, a press cannot know which way it goes: a viewer
  // who already liked would publish a second like instead of an unlike, and the
  // tile could not show it. Signed out, the press only opens sign-in.
  const reading = !!identity && !tally;
  const error = failure && failure.key === `${itemGuid}:${liked}` ? failure.msg : null;
  const count = tally?.count ?? 0;
  // `+` for a capped read AND for one that missed a relay: both are lower
  // bounds, and `N+` is still true of an exact N, so it cannot overstate.
  const countLabel = count > 0 ? `${compact.format(count)}${tally?.capped || !complete ? '+' : ''}` : null;

  async function onPress(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    // While WAITING, a press is the way out: it stops the wait for the signer.
    if (busy && waiting) {
      stop.current?.abort();
      return;
    }
    if (busy || reading) return;
    if (!identity) {
      setSignInOpen(true);
      return;
    }
    const key = `${itemGuid}:${liked}`;
    const controller = new AbortController();
    stop.current = controller;
    setBusy(true);
    setFailure(null);
    const slow = setTimeout(() => setWaiting(true), SIGNER_WAIT_MS);
    // WAITING names the SIGNER, so it ends when the signer answers. It used to
    // run until the slowest publish relay had settled too, and told a Clave user
    // with full approval that their signer was slow while a relay was. The tile
    // stays busy through the publish, which now ends on the first acceptance.
    const onSigned = () => {
      clearTimeout(slow);
      setWaiting(false);
    };
    try {
      const signal = controller.signal;
      if (liked) await unlikeEpisode({ itemGuid: itemGuid!, likeIds: tally!.viewerLikeIds, identity, signal, onSigned });
      else await likeEpisode({ itemGuid: itemGuid!, feedGuid: feedGuid!, identity, signal, onSigned });
    } catch (err) {
      // A guard that silently withholds must say so: the tile keeps its state,
      // and says why under itself rather than in the console.
      setFailure({ key, msg: likeFailureText(err, liked) });
    } finally {
      clearTimeout(slow);
      if (stop.current === controller) stop.current = null;
      setWaiting(false);
      setBusy(false);
    }
  }

  const people = !countLabel ? '' : countLabel === '1' ? ' 1 person likes this.' : ` ${countLabel} people like this.`;
  const title = waiting
    ? 'Waiting for your signer to answer. Press to stop waiting.'
    : error
    ? error
    : !identity
      ? `Like on Nostr (sign in first).${people}`
      : reading
        ? 'Reading likes from Nostr…'
        : liked
          ? `Unlike (publishes a Nostr deletion).${people}`
          : `Like on Nostr.${people}`;

  return (
    <>
      <button
        type="button"
        onClick={onPress}
        disabled={(busy && !waiting) || reading}
        aria-pressed={liked}
        aria-busy={busy || reading}
        aria-label={waiting
          ? 'Waiting for your signer. Press to stop waiting'
          : `${liked ? 'Unlike' : 'Like'} episode${countLabel ? `, ${countLabel} ${countLabel === '1' ? 'like' : 'likes'}` : ''}`}
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
        {waiting ? 'WAITING' : error ? 'RETRY' : 'LIKE'}
      </button>
      {error && (
        <p role="alert" className="col-span-full order-last basis-full text-[11px] leading-tight text-red-400">
          {error}
        </p>
      )}
    </>
  );
}
