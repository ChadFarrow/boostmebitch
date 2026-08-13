'use client';
import type { Episode, Podcast, FavoriteEpisode, FavoritePodcast } from '@/lib/types';
import { useApp } from '@/lib/store';
import { requestFavoritesSync } from '@/lib/nostr';

// The ♡ / ♥ favorite toggle. Lives in its own module (rather than lists.tsx)
// because several unrelated surfaces render it — the podcast rows + show header
// in lists.tsx, the episode list and detail view, the fullscreen player, and the
// podroll row — and having podroll reach into lists.tsx for it while lists.tsx
// imports <Podroll> made a module cycle. `size`: 'sm' is the slim chip used in
// list rows; 'md' matches .btn-ghost dimensions so it reads as a peer to SHARE
// and BOOST in the header.
//
// Both shows and episodes go into ONE Nostr list, so both toggles schedule the
// same `requestFavoritesSync`. See lib/nostr/favorites.ts.

type Size = 'sm' | 'md';

function heartClasses(isFav: boolean, size: Size) {
  return `inline-flex items-center justify-center font-mono uppercase tracking-wider border transition active:translate-y-px flex-shrink-0 ${
    size === 'md' ? 'gap-2 px-4 py-2 text-sm' : 'gap-1.5 px-3 text-xs leading-none'
  } ${
    isFav
      ? 'border-nostr text-nostr hover:bg-nostr/10'
      : 'border-bone/40 text-bone/70 hover:border-nostr/70 hover:text-nostr'
  }`;
}

function HeartButton({
  isFav,
  size,
  synced,
  onToggle,
  label,
}: {
  isFav: boolean;
  size: Size;
  synced: boolean;
  onToggle: (e: React.MouseEvent) => void;
  label: string;
}) {
  return (
    <button
      onClick={onToggle}
      aria-label={isFav ? `Unfavorite ${label}` : `Favorite ${label}`}
      title={
        synced
          ? (isFav ? 'Unfavorite (synced to Nostr)' : 'Favorite (syncs to Nostr)')
          : (isFav ? 'Unfavorite' : 'Favorite (sign in with Nostr to sync)')
      }
      className={heartClasses(isFav, size)}
    >
      <span className={size === 'md' ? 'text-lg leading-none' : 'text-base leading-none'}>
        {isFav ? '♥' : '♡'}
      </span>
      {isFav ? 'FAVORITED' : 'FAVORITE'}
    </button>
  );
}

/**
 * The `<podcast:medium>` that may be published for a feed, or undefined.
 *
 * **Only what the FEED declared ever reaches the wire.** `Podcast.medium` is
 * populated from Podcast Index (`lib/pi.ts`) or the RSS channel parse
 * (`app/api/feed/route.ts`) — both of those are the feed speaking, and both are
 * fine. What is not fine is this app's own conclusion about a show: a guess
 * published to a shared list is one no other app will ever correct, and the
 * position exists precisely because the list carries podcasts and music at once.
 *
 * The one synthetic value in the codebase is the publisher stub `<HomePage>`
 * builds for a cold restore — `{ id: 0, title: 'Publisher', medium: 'publisher' }`
 * — which is a back-button label, not a declaration. It has no `podcastGuid`, so
 * it can't be favorited today, but that is an accident of an unrelated guard
 * rather than a rule. `id <= 0` means nothing ever resolved this feed.
 */
function declaredMedium(podcast?: Podcast | null): string | undefined {
  if (!podcast || podcast.id <= 0) return undefined;
  return podcast.medium;
}

export function FavHeart({ podcast, size = 'sm' }: { podcast: Podcast; size?: Size }) {
  const guid = podcast.podcastGuid;
  const isFav = useApp((s) => s.isFavorite(guid));
  const addFavorite = useApp((s) => s.addFavorite);
  const removeFavorite = useApp((s) => s.removeFavorite);
  const identity = useApp((s) => s.identity);

  if (!guid) return null; // can't favorite a podcast without a canonical GUID

  function toggle(e: React.MouseEvent) {
    // Cards and rows that embed this heart are themselves clickable (play /
    // open the show), so the toggle must not bubble.
    e.stopPropagation();
    e.preventDefault();
    if (isFav) {
      removeFavorite(guid!);
    } else {
      const fav: FavoritePodcast = {
        id: podcast.id,
        podcastGuid: guid!,
        title: podcast.title,
        author: podcast.author,
        image: podcast.image,
        artwork: podcast.artwork,
        url: podcast.url,
        medium: declaredMedium(podcast),
        addedAt: Date.now(),
      };
      addFavorite(fav);
    }
    requestFavoritesSync(identity);
  }

  return (
    <HeartButton
      isFav={isFav}
      size={size}
      synced={!!identity}
      onToggle={toggle}
      label="podcast"
    />
  );
}

/**
 * The same toggle for a single episode. `podcast` supplies the parent feed's
 * guid and URL, which the episode itself often doesn't carry — PI's
 * /episodes/byguid needs `podcastguid`, so an episode favorite with no parent
 * feed is unresolvable on any other device and is not offered at all.
 */
export function FavEpisodeHeart({
  episode,
  podcast,
  size = 'sm',
}: {
  episode: Episode;
  podcast?: Podcast | null;
  size?: Size;
}) {
  const itemGuid = episode.guid;
  const feedGuid = episode.podcastGuid || podcast?.podcastGuid;
  const isFav = useApp((s) => s.isFavoriteEpisode(itemGuid));
  const addFavoriteEpisode = useApp((s) => s.addFavoriteEpisode);
  const removeFavoriteEpisode = useApp((s) => s.removeFavoriteEpisode);
  const identity = useApp((s) => s.identity);

  // Same rule as <FavHeart>: no canonical identifier, no heart. An episode
  // needs both halves — the item guid to name it and the feed guid to find it.
  if (!itemGuid || !feedGuid) return null;

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (isFav) {
      removeFavoriteEpisode(itemGuid!);
    } else {
      const fav: FavoriteEpisode = {
        itemGuid: itemGuid!,
        feedGuid: feedGuid!,
        feedId: episode.feedId,
        feedUrl: podcast?.url,
        title: episode.title,
        podcastTitle: episode.feedTitle || podcast?.title,
        image: episode.image || episode.feedImage || podcast?.image,
        enclosureUrl: episode.enclosureUrl,
        datePublished: episode.datePublished,
        // The PARENT FEED's medium — Podcasting 2.0 has no per-item one, and
        // `podcast` here is that feed.
        medium: declaredMedium(podcast),
        addedAt: Date.now(),
      };
      addFavoriteEpisode(fav);
    }
    requestFavoritesSync(identity);
  }

  return (
    <HeartButton
      isFav={isFav}
      size={size}
      synced={!!identity}
      onToggle={toggle}
      label="episode"
    />
  );
}
