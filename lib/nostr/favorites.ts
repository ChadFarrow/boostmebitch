import type { EventTemplate } from 'nostr-tools';
import { withPool } from './pool';
import { DEFAULT_RELAYS } from './relays';
import { signAndPublish, type PublishedNote } from './publish';

// NIP-51 favorites — kind:30003 bookmark set, identified by our `d` tag.

export const FAVORITES_D_TAG = 'boostmebitch:favorites';

export interface FavoritesEvent {
  guids: string[];
  updatedAt: number; // unix seconds, from event.created_at
}

export async function fetchFavoriteGuids(
  pubkey: string,
  queryRelays?: string[],
): Promise<FavoritesEvent | null> {
  const useRelays = queryRelays ?? DEFAULT_RELAYS;
  return withPool(useRelays, async (pool) => {
    try {
      const events = await pool.querySync(useRelays, {
        kinds: [30003],
        authors: [pubkey],
        '#d': [FAVORITES_D_TAG],
        limit: 1,
      });
      if (!events.length) return null;
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
      const guids: string[] = [];
      for (const tag of newest.tags) {
        if (tag[0] !== 'i' || !tag[1]) continue;
        const m = /^podcast:guid:(.+)$/.exec(tag[1]);
        if (m) guids.push(m[1]);
      }
      return { guids, updatedAt: newest.created_at };
    } catch {
      return null;
    }
  });
}

export async function publishFavorites(
  guids: string[],
  relays: string[],
): Promise<PublishedNote> {
  const tags: string[][] = [
    ['d', FAVORITES_D_TAG],
    ['title', 'Favorite Podcasts'],
  ];
  for (const guid of guids) {
    tags.push(['i', `podcast:guid:${guid}`]);
    tags.push(['k', 'podcast:guid']);
  }
  const template: EventTemplate = {
    kind: 30003,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  };
  return signAndPublish(template, relays);
}

// Debounced wrapper — collapses rapid heart-toggles into a single signing prompt.
let publishFavoritesTimer: ReturnType<typeof setTimeout> | null = null;
export function schedulePublishFavorites(
  getGuids: () => string[],
  relays: string[],
  delayMs = 1500,
) {
  if (publishFavoritesTimer) clearTimeout(publishFavoritesTimer);
  publishFavoritesTimer = setTimeout(() => {
    publishFavoritesTimer = null;
    publishFavorites(getGuids(), relays).catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[favorites] publish failed:', e?.message ?? e);
    });
  }, delayMs);
}
