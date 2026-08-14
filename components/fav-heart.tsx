'use client';
import type { Episode, Podcast, FavoriteEpisode, FavoritePodcast } from '@/lib/types';
import { useApp } from '@/lib/store';
import { requestFavoritesSync } from '@/lib/nostr';
import { isMusicMedium } from '@/lib/util';

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

// `flex-shrink-0` is in the BASE string on purpose — a fixed-size control should
// not squash. The mobile fix is making it SMALL (the 'sm' chip drops its word
// below sm:), not making it shrinkable.
//
// Touch target comes from min-h/min-w rather than padding: adding `py` to 'sm'
// would change the chip on DESKTOP too, visibly, at lists.tsx (favorite-episode
// rows) and podroll.tsx, where it is `self-center` and ~18px tall.
function heartClasses(isFav: boolean, size: Size) {
  return `inline-flex items-center justify-center font-mono uppercase tracking-wider border transition active:translate-y-px flex-shrink-0 ${
    size === 'md'
      ? 'gap-1.5 px-2.5 py-2 text-sm sm:gap-2 sm:px-4'
      : 'gap-1.5 px-3 text-xs leading-none min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0'
  } ${
    isFav
      ? 'border-nostr text-nostr hover:bg-nostr/10'
      : 'border-bone/40 text-bone/70 hover:border-nostr/70 hover:text-nostr'
  }`;
}

/**
 * The visible word when a heart is asked to name its TARGET rather than its
 * action — `nameTarget`, below.
 *
 * The vocabulary lives here rather than at the call site on purpose: two
 * surfaces inventing their own nouns is how "EPISODE" and "TRACK" end up
 * meaning the same thing on two screens. `isMusicMedium` is the same gate the
 * rest of the app branches on, so a music feed says ALBUM/TRACK everywhere or
 * nowhere.
 */
function targetWord(kind: 'feed' | 'item', podcast?: Podcast | null): string {
  const music = !!podcast && isMusicMedium(podcast);
  if (kind === 'feed') return music ? 'ALBUM' : 'SHOW';
  return music ? 'TRACK' : 'EPISODE';
}

function HeartButton({
  isFav,
  size,
  synced,
  onToggle,
  label,
  word,
}: {
  isFav: boolean;
  size: Size;
  synced: boolean;
  onToggle: (e: React.MouseEvent) => void;
  label: string;
  /** Replaces FAVORITE/FAVORITED. See `nameTarget` on the exported hearts. */
  word?: string;
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
      {/* 'sm' is the list-row chip: at 390px it competes with a BOOST button and
          the episode title inside a ~314px row, and the word alone is ~70px of
          it — so below sm: it collapses to the glyph and leans on the aria-label
          above, which already carries the full meaning. 'md' keeps the word at
          every width: it lives in a full-width cluster and is deliberately
          dimensioned to match .btn-ghost (see the note at the top of this file).
          `hidden` is display:none, so the label is not a flex item and gap-1.5
          contributes nothing — the mobile chip is exactly a 44x44 glyph square. */}
      {/* When `word` is set it names the target and the FILLED, magenta heart
          is what says "favorited" — the glyph already carried that state, so
          repeating it in text was the redundancy that made two adjacent hearts
          indistinguishable. The aria-label is unaffected either way: it always
          spells out the whole action ("Unfavorite podcast"). */}
      <span className={size === 'md' ? undefined : 'hidden sm:inline'}>
        {word ?? (isFav ? 'FAVORITED' : 'FAVORITE')}
      </span>
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

/**
 * `nameTarget` makes the button read `♡ SHOW` / `♡ ALBUM` instead of
 * `♡ FAVORITE`. Pass it wherever a show heart and an episode heart sit in the
 * SAME cluster — today that is only the fullscreen player, where the two
 * rendered identical words next to each other and nothing on screen said which
 * one favorited what. Everywhere else a heart is alone in its row and the plain
 * FAVORITE is the better word, so this is opt-in rather than the default.
 */
export function FavHeart({
  podcast,
  size = 'sm',
  nameTarget = false,
}: {
  podcast: Podcast;
  size?: Size;
  nameTarget?: boolean;
}) {
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
      word={nameTarget ? targetWord('feed', podcast) : undefined}
    />
  );
}

/**
 * The same toggle for a single episode. `podcast` supplies the parent feed's
 * guid and URL, which the episode itself often doesn't carry — PI's
 * /episodes/byguid needs `podcastguid`, so an episode favorite with no parent
 * feed is unresolvable on any other device and is not offered at all.
 */
/**
 * The heart for a row on the favorites list itself, where the entry is ALREADY
 * a `FavoriteEpisode`.
 *
 * Separate from {@link FavEpisodeHeart} because that one builds a favorite out
 * of an `Episode` + its parent `Podcast`, and the favorites list has neither —
 * it has the stored row. Reconstructing a synthetic `Episode` just to hand it
 * back would drop whatever the stored row knows that an `Episode` has no field
 * for (the medium hint another app wrote, most obviously), so an unfavorite
 * followed by a re-favorite would quietly downgrade the entry. Re-adding the
 * stored object verbatim is lossless.
 *
 * `addedAt` is deliberately NOT restamped: the row keeps its place in the list
 * instead of jumping to the top, which is what you want when the toggle was a
 * misfire.
 */
export function FavEpisodeRowHeart({
  favorite,
  size = 'sm',
}: {
  favorite: FavoriteEpisode;
  size?: Size;
}) {
  const isFav = useApp((s) => s.isFavoriteEpisode(favorite.itemGuid));
  const addFavoriteEpisode = useApp((s) => s.addFavoriteEpisode);
  const removeFavoriteEpisode = useApp((s) => s.removeFavoriteEpisode);
  const identity = useApp((s) => s.identity);

  function toggle(e: React.MouseEvent) {
    // The row is clickable (it opens the show), so the toggle must not bubble.
    e.stopPropagation();
    e.preventDefault();
    if (isFav) removeFavoriteEpisode(favorite.itemGuid);
    else addFavoriteEpisode(favorite);
    requestFavoritesSync(identity);
  }

  return (
    <HeartButton isFav={isFav} size={size} synced={!!identity} onToggle={toggle} label="episode" />
  );
}

export function FavEpisodeHeart({
  episode,
  podcast,
  size = 'sm',
  nameTarget = false,
}: {
  episode: Episode;
  podcast?: Podcast | null;
  size?: Size;
  /** See the note on {@link FavHeart}. */
  nameTarget?: boolean;
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
      word={nameTarget ? targetWord('item', podcast) : undefined}
    />
  );
}
