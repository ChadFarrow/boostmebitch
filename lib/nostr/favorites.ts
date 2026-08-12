import type { EventTemplate } from 'nostr-tools';
import { DEFAULT_RELAYS } from './relays';
import { signAndPublish, type PublishedNote } from './publish';
import { fetchLatestEventDetailed } from './event-queries';
import { createScheduledPublish } from './debounced-publish';
import {
  itemsFromTags,
  otherTagsFrom,
  mergeSharedFavorites,
  tagsForSharedFavorites,
  LEGACY_D_TAG,
  SHARED_D_TAG,
  type SharedFavoriteItem,
} from './favorites-merge';

// ---------------------------------------------------------------------------
// Cross-app favorites — the I/O half. The wire format and the merge live in
// `favorites-merge.ts`, which is import-free so scripts/check-favsync.mjs can
// load the real thing; everything there is re-exported below so callers only
// import this module.
//
// This event is SHARED with other podcast apps (StableKraft first). It is a
// replaceable event at a well-known address, so every writer can destroy every
// other writer's data with one blind publish. That is why there is no exported
// "publish my favorites" — only `syncFavorites`, which reads first.
// ---------------------------------------------------------------------------

export * from './favorites-merge';

export interface SharedFavorites {
  /** Every `i` tag, in event order, including kinds this app can't read. */
  items: SharedFavoriteItem[];
  /** Tags belonging to other writers, preserved verbatim on republish. */
  otherTags: string[][];
  /** unix seconds, from event.created_at. 0 when no event exists. */
  updatedAt: number;
  /** An event was found. */
  exists: boolean;
  /**
   * The read can be trusted. False means "nothing answered", NOT "the list is
   * empty" — never merge or publish on top of a false here, or a relay wobble
   * silently wipes favorites this device never saw.
   */
  trustworthy: boolean;
}

async function fetchList(
  pubkey: string,
  dTag: string,
  relays: string[],
): Promise<SharedFavorites> {
  const { event, trustworthy } = await fetchLatestEventDetailed(relays, {
    kinds: [30003],
    authors: [pubkey],
    '#d': [dTag],
    limit: 1,
  });
  if (!event) {
    return { items: [], otherTags: [], updatedAt: 0, exists: false, trustworthy };
  }
  return {
    items: itemsFromTags(event.tags),
    otherTags: otherTagsFrom(event.tags),
    updatedAt: event.created_at,
    exists: true,
    trustworthy: true, // an event in hand is its own proof the query worked
  };
}

/** Read the shared cross-app list. */
export function fetchSharedFavorites(
  pubkey: string,
  queryRelays?: string[],
): Promise<SharedFavorites> {
  return fetchList(pubkey, SHARED_D_TAG, queryRelays ?? DEFAULT_RELAYS);
}

/** Read this app's pre-sync list. Migration only — never republished here. */
export function fetchLegacyFavorites(
  pubkey: string,
  queryRelays?: string[],
): Promise<SharedFavorites> {
  return fetchList(pubkey, LEGACY_D_TAG, queryRelays ?? DEFAULT_RELAYS);
}

export async function publishSharedFavorites(
  items: SharedFavoriteItem[],
  otherTags: string[][],
  relays: string[],
): Promise<PublishedNote> {
  const template: EventTemplate = {
    kind: 30003,
    created_at: Math.floor(Date.now() / 1000),
    tags: tagsForSharedFavorites(items, otherTags),
    content: '',
  };
  return signAndPublish(template, relays);
}

export interface SyncOptions {
  pubkey: string;
  relays: string[];
  /** This device's current favorites, as wire items. */
  local: () => SharedFavoriteItem[];
  /** The id list this device last agreed with the relay on. */
  lastSynced: () => string[];
  /** Called with the published id list once the event lands. */
  onSynced: (ids: string[]) => void;
}

/**
 * Read → merge → publish, in one step. The read is what makes the write safe,
 * so they are never separated: a caller that could publish without reading is
 * a caller that can wipe another app's favorites.
 *
 * Returns null without publishing when the read was degraded. Losing a
 * republish is recoverable — the next toggle or page load retries it — whereas
 * publishing over a list we couldn't read is not.
 */
export async function syncFavorites(opts: SyncOptions): Promise<PublishedNote | null> {
  const latest = await fetchSharedFavorites(opts.pubkey, opts.relays);
  if (!latest.trustworthy) {
    // eslint-disable-next-line no-console
    console.warn('[favorites] skipping publish — could not read the current list');
    return null;
  }
  const next = mergeSharedFavorites({
    latest: latest.items,
    lastSynced: opts.lastSynced(),
    local: opts.local(),
  });
  const published = await publishSharedFavorites(next, latest.otherTags, opts.relays);
  opts.onSynced(next.map((i) => i.id));
  return published;
}

// Debounced wrapper — collapses rapid heart-toggles into a single read-merge-
// publish cycle, and so a single signing prompt. The getters are re-read at
// fire time, so a burst publishes once with the final set.
const _schedulePublish = createScheduledPublish('favorites');

export function scheduleSyncFavorites(opts: SyncOptions, delayMs = 1500) {
  _schedulePublish(() => syncFavorites(opts), delayMs);
}
