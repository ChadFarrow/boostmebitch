'use client';
import type { Podcast, FavoritePodcast } from '@/lib/types';
import { useApp, epKey } from '@/lib/store';
import type { Episode } from '@/lib/types';
import { resolvePublishRelays, schedulePublishFavorites } from '@/lib/nostr';

// On favoriting, mark a show's recent back-catalog seen EXCEPT its newest
// episode, so the Inbox surfaces just "1 NEW" (the latest, as a "just added"
// marker) instead of flooding with the whole last-30-days. Best-effort: any
// failure just leaves the recent episodes showing as new. Uses the same
// 30-day-bounded route the Inbox reads.
async function seedFavoriteBaseline(feedId: number, seedSeenKeys: (keys: string[]) => void) {
  try {
    const r = await fetch(`/api/new-episodes?ids=${feedId}`);
    const d = await r.json();
    const eps: Episode[] = (d.episodes ?? [])
      .filter((e: Episode) => !!e.guid)
      .sort((a: Episode, b: Episode) => (b.datePublished ?? 0) - (a.datePublished ?? 0));
    if (eps.length > 1) seedSeenKeys(eps.slice(1).map(epKey));
  } catch {
    /* best-effort — leave the recent episodes as new */
  }
}

// The ♡ / ♥ favorite toggle. Lives in its own module (rather than lists.tsx)
// because three unrelated surfaces render it — the podcast rows + show header
// in lists.tsx, the fullscreen player, and the podroll row — and having podroll
// reach into lists.tsx for it while lists.tsx imports <Podroll> made a module
// cycle. `size`: 'sm' is the slim chip used in list rows; 'md' matches
// .btn-ghost dimensions so it reads as a peer to SHARE and BOOST in the header.
export function FavHeart({ podcast, size = 'sm' }: { podcast: Podcast; size?: 'sm' | 'md' | 'icon' }) {
  const guid = podcast.podcastGuid;
  const isFav = useApp((s) => s.isFavorite(guid));
  const addFavorite = useApp((s) => s.addFavorite);
  const removeFavorite = useApp((s) => s.removeFavorite);
  const seedSeenKeys = useApp((s) => s.seedSeenKeys);
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
        addedAt: Date.now(),
      };
      addFavorite(fav);
      // Baseline the Inbox: only the newest episode shows as NEW for a show you
      // just added (rest of the recent back-catalog is pre-marked seen).
      void seedFavoriteBaseline(podcast.id, seedSeenKeys);
    }
    if (identity) {
      schedulePublishFavorites(
        () => Object.keys(useApp.getState().favorites),
        resolvePublishRelays(identity),
      );
    }
  }

  // Icon-only: a bare heart glyph, no border/label. Used where the favorite
  // state is implied by context (e.g. the Inbox, which is a list of favorites)
  // so a full "FAVORITED" button would just be noise — the heart still toggles.
  if (size === 'icon') {
    return (
      <button
        onClick={toggle}
        aria-label={isFav ? 'Unfavorite' : 'Favorite'}
        title={
          identity
            ? (isFav ? 'Unfavorite (synced to Nostr)' : 'Favorite (syncs to Nostr)')
            : (isFav ? 'Unfavorite' : 'Favorite (sign in with Nostr to sync)')
        }
        className={`inline-flex items-center justify-center p-1 text-xl leading-none transition active:translate-y-px flex-shrink-0 ${
          isFav ? 'text-nostr hover:text-nostr/70' : 'text-bone/50 hover:text-nostr'
        }`}
      >
        {isFav ? '♥' : '♡'}
      </button>
    );
  }

  return (
    <button
      onClick={toggle}
      aria-label={isFav ? 'Unfavorite' : 'Favorite'}
      title={
        identity
          ? (isFav ? 'Unfavorite (synced to Nostr)' : 'Favorite (syncs to Nostr)')
          : (isFav ? 'Unfavorite' : 'Favorite (sign in with Nostr to sync)')
      }
      className={`inline-flex items-center justify-center font-mono uppercase tracking-wider border transition active:translate-y-px flex-shrink-0 ${
        size === 'md'
          ? 'gap-2 px-4 py-2 text-sm'
          : 'gap-1.5 px-3 text-xs leading-none'
      } ${
        isFav
          ? 'border-nostr text-nostr hover:bg-nostr/10'
          : 'border-bone/40 text-bone/70 hover:border-nostr/70 hover:text-nostr'
      }`}
    >
      <span className={size === 'md' ? 'text-lg leading-none' : 'text-base leading-none'}>
        {isFav ? '♥' : '♡'}
      </span>
      {isFav ? 'FAVORITED' : 'FAVORITE'}
    </button>
  );
}
