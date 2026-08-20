'use client';

// The favorites ROWS, and the paged bodies that render them.
//
// This file used to also own the two medium-grouped panels that the home page
// rendered in a `max-h-[70vh]` aside. Those are gone: favorites now have their
// own route, and medium is a tab strip there rather than a stack of headings
// (see `components/favorites-page.tsx`). What stayed here is everything that
// draws one favorite, because a row is the piece more than one surface can
// plausibly want and the piece this repo keeps getting burned by duplicating.
//
// The rows are driven by the store's `favorites` / `favoriteEpisodes` maps,
// which are the source of truth for what gets PUBLISHED, not a render cache: an
// id with no resolved Podcast Index metadata still gets a row, as an
// <UnresolvedFavoriteRow> placeholder. Dropping unresolved entries here would
// make a PI outage look like the user had removed them.

import type { FavoriteEpisode, FavoritePodcast, Podcast } from '@/lib/types';
import { PodcastCover } from '../podcast-cover';
import { FavEpisodeRowHeart, FavFeedRowHeart } from '../fav-heart';
import { PodcastRow } from './podcast-results';
import { useRevealed, useAutoReveal, ShowMore } from './grouping';

export type FavSort = 'recent' | 'az';

type Sortable = { title?: string; addedAt: number };

/**
 * Order for both favorites lists, shared because both row types carry the two
 * fields it reads. Returns a new array; the store maps are not ours to reorder.
 *
 * **Untitled entries sink in BOTH orders, and that is not cosmetic.** An
 * unresolved entry has no title, so A-Z would sort every one of them above the
 * whole library behind an empty string — placeholders first, actual favorites
 * below. `addedAt: 0` means "not known yet" and already sinks under `recent`
 * for the same reason.
 *
 * Kept here rather than in `lib/util.ts`: that file holds the pure MONEY
 * arithmetic and its import line is load-bearing infrastructure for the check
 * scripts that load it under plain Node. A UI comparator has no business near
 * that constraint.
 */
export function sortFavorites<T extends Sortable>(rows: T[], sort: FavSort): T[] {
  return [...rows].sort((a, b) => {
    if (!a.title !== !b.title) return a.title ? -1 : 1;
    if (sort === 'recent') return b.addedAt - a.addedAt;
    return (a.title ?? '').localeCompare(b.title ?? '', undefined, { sensitivity: 'base' });
  });
}

/**
 * A favorite whose identifier this device can't resolve.
 *
 * It exists because the favorite is the guid, not the metadata: an entry
 * Podcast Index doesn't know is not an entry we may drop, so it has to have
 * somewhere to go on screen. Nothing to OPEN — there is no show and no episode
 * behind it — but it must still carry its heart.
 *
 * **The heart is the whole reason this row is rendered rather than hidden, and
 * it shipped without one.** The argument for showing an unresolvable entry has
 * always been "a row they can see is one they can clean up", and without a
 * control on it that sentence is false: the entry is unremovable through the
 * UI, permanently, and rides through every republish to a list other apps read.
 * `bmbCleanFavorites()` does not reach it either — that purges malformed
 * `podcast:guid:` nodes, and these are well-formed identifiers for something PI
 * has simply never indexed. Nothing else on any screen can remove them.
 *
 * Both hearts are the row-shaped variants, which take the STORED entry and
 * re-add it verbatim. That matters most here: an unresolved entry's `medium`
 * hint is the only description of it that exists, and rebuilding the favorite
 * from a synthesized `Podcast` / `Episode` would drop it.
 */
export function UnresolvedFavoriteRow({
  id,
  kind,
  heart,
}: {
  id: string;
  kind: 'show' | 'episode';
  heart: React.ReactNode;
}) {
  return (
    <li className="flex gap-3 py-3 px-1 items-center">
      <div className="w-14 h-14 border border-bone/20 flex-shrink-0 grid place-items-center text-muted text-xl">
        ?
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-display text-base leading-tight text-muted">
          Couldn&apos;t load this {kind}
        </div>
        <div className="text-[11px] font-mono text-muted/70 truncate">{id}</div>
      </div>
      <div className="flex-shrink-0 self-center">{heart}</div>
    </li>
  );
}

/**
 * One favorited item (episode or track).
 *
 * Presentation only — `onOpen` is injected, because opening a favorite means
 * resolving a parent feed and then navigating, and the surface doing the
 * navigating is the one that knows where it is. See
 * `components/favorites-page.tsx` for that chain and for why the show goes up
 * before the episode.
 */
export function FavoriteItemRow({
  ep,
  onOpen,
}: {
  ep: FavoriteEpisode;
  onOpen: (ep: FavoriteEpisode) => void;
}) {
  const title = ep.title!;
  return (
    <li
      className="flex gap-3 py-3 px-1 cursor-pointer group transition hover:bg-bone/5"
      onClick={() => onOpen(ep)}
    >
      <PodcastCover
        image={ep.image}
        title={title}
        seed={ep.itemGuid}
        className="w-14 h-14 border border-bone/20 flex-shrink-0 text-xl"
      />
      <div className="min-w-0 flex-1">
        <div className="font-display text-base leading-tight truncate">{title}</div>
        {/* Only when it says something the title didn't. A single names its
            album after its one track, so printing both renders the same words
            twice and reads as an album sitting in the episodes list — 74 of one
            user's 227 tracks. */}
        {ep.podcastTitle && ep.podcastTitle !== title && (
          <div className="text-xs text-muted truncate">{ep.podcastTitle}</div>
        )}
      </div>
      <div className="flex-shrink-0 self-center">
        <FavEpisodeRowHeart favorite={ep} />
      </div>
    </li>
  );
}

/**
 * The paged `<ul>` both sections render.
 *
 * `useRevealed` is what bounds the cost of an open list — see its own note for
 * why twelve, and why `loading="lazy"` was not enough. `resetKey` must name
 * every control that changes which rows these are, or clearing a filter mounts
 * whatever the user had revealed before it.
 *
 * `listId` comes from `useId()` and is handed BACK to the caller's heading via
 * the `id` prop, because `aria-controls` must point at an element that exists
 * even while the section is folded — which is why the `<ul>` is `hidden`
 * rather than unrendered, while its ROWS are unmounted.
 *
 * `noun` is a FUNCTION of a count, not a string, because the only number the
 * caller has is the section total and the only number the label is read
 * against is `remaining` — which lives in here. Handing a finished string
 * across that gap is how "show 1 more singles" gets printed.
 */
function PagedList<T>({
  id,
  rows,
  resetKey,
  hidden,
  noun,
  render,
}: {
  id: string;
  rows: T[];
  resetKey: string;
  hidden: boolean;
  noun: (n: number) => string;
  render: (row: T) => React.ReactNode;
}) {
  const { visible, remaining, more } = useRevealed(rows, resetKey);
  // The next page reveals itself when the control below scrolls into view; the
  // control stays a real button so a missing IntersectionObserver still leaves
  // the rows reachable. Passed `hidden ? 0 : remaining` rather than gated by an
  // early return, because a hook may not be conditional — and a folded section
  // must not auto-reveal rows nobody can see, which would spend the whole bytes
  // budget on artwork behind a closed heading.
  const sentinel = useAutoReveal(hidden ? 0 : remaining, more);
  return (
    <>
      <ul id={id} className="divide-y divide-bone/10" hidden={hidden}>
        {hidden ? null : visible.map(render)}
      </ul>
      {/* Suppressed while folded, or a closed section still offers to reveal
          twelve more of the rows it is currently hiding. */}
      {!hidden && (
        <ShowMore remaining={remaining} onClick={more} noun={noun(remaining)} innerRef={sentinel} />
      )}
    </>
  );
}

/** Favorited feeds — albums and shows. */
export function FavoriteFeedRows({
  id,
  rows,
  resetKey,
  hidden,
  noun,
  onSelect,
}: {
  id: string;
  rows: FavoritePodcast[];
  resetKey: string;
  hidden: boolean;
  noun: (n: number) => string;
  onSelect: (p: Podcast) => void;
}) {
  return (
    <PagedList
      id={id}
      rows={rows}
      resetKey={resetKey}
      hidden={hidden}
      noun={noun}
      render={(p) => {
        const title = p.title;
        // No title means Podcast Index hasn't answered for this guid — a feed
        // that was never indexed, or has since been delisted. Render it rather
        // than hiding it: it is still the user's favorite and is still
        // republished, and a row they can see is one they can clean up.
        if (!title) {
          return (
            <UnresolvedFavoriteRow
              key={p.podcastGuid}
              id={p.podcastGuid}
              kind="show"
              heart={<FavFeedRowHeart favorite={p} />}
            />
          );
        }
        // FavoritePodcast → Podcast: the cache doesn't carry the value block,
        // so the value-aware stamp is hidden via showV4VStamp.
        const minimal: Podcast = {
          id: p.id,
          podcastGuid: p.podcastGuid,
          title,
          author: p.author,
          image: p.image,
          artwork: p.artwork,
          url: p.url,
        };
        return (
          <PodcastRow
            key={p.podcastGuid}
            podcast={minimal}
            selected={false}
            onSelect={onSelect}
            showV4VStamp={false}
          />
        );
      }}
    />
  );
}

/** Favorited items — episodes and tracks. */
export function FavoriteItemRows({
  id,
  rows,
  resetKey,
  hidden,
  noun,
  onOpen,
}: {
  id: string;
  rows: FavoriteEpisode[];
  resetKey: string;
  hidden: boolean;
  noun: (n: number) => string;
  onOpen: (ep: FavoriteEpisode) => void;
}) {
  return (
    <PagedList
      id={id}
      rows={rows}
      resetKey={resetKey}
      hidden={hidden}
      noun={noun}
      render={(ep) =>
        // Unresolved: no parent feed guid to look up, or PI had nothing for it.
        // Still the user's favorite, still republished — see
        // <UnresolvedFavoriteRow>.
        ep.title
          ? <FavoriteItemRow key={ep.itemGuid} ep={ep} onOpen={onOpen} />
          : (
            <UnresolvedFavoriteRow
              key={ep.itemGuid}
              id={ep.itemGuid}
              kind="episode"
              heart={<FavEpisodeRowHeart favorite={ep} />}
            />
          )
      }
    />
  );
}
